require("dotenv").config();
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 5000;

// --- MIDDLEWARES ---
app.use(
  cors({
    origin: ["http://localhost:5174"], // Frontend URL
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());

// --- CUSTOM MIDDLEWARES (Global) ---
const verifyToken = (req, res, next) => {
  if (!req.headers.authorization) {
    return res.status(401).send({ message: "unauthorized access" });
  }
  const token = req.headers.authorization.split(" ")[1];
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(401).send({ message: "unauthorized access" });
    }
    req.decoded = decoded;
    next();
  });
};

// --- MONGODB CONNECTION ---
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // await client.connect();

    const db = client.db("assetVerseDB");
    const usersCollection = db.collection("users");
    const assetsCollection = db.collection("assets");
    const requestsCollection = db.collection("requests");
    const employeeAffiliationsCollection = db.collection(
      "employeeAffiliations"
    );
    const assignedAssetsCollection = db.collection("assignedAssets"); // For direct assignments & history
    const paymentsCollection = db.collection("payments");

    // --- VERIFY HR MIDDLEWARE (Requires DB Access) ---
    const verifyHR = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email: email };
      const user = await usersCollection.findOne(query);
      const isHR = user?.role === "hr";
      if (!isHR) {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };

    // ==============================================================
    // 🔐 AUTH & USERS APIs
    // ==============================================================

    // JWT Generate
    app.post("/jwt", async (req, res) => {
      const user = req.body;
      const token = jwt.sign(user, process.env.JWT_SECRET, { expiresIn: "1h" });
      res.send({ token });
    });

    // Create / Update User (Social Login & Register)
    app.post("/users", async (req, res) => {
      const user = req.body;
      const query = { email: user.email };
      const existingUser = await usersCollection.findOne(query);
      if (existingUser) {
        return res.send({ message: "user already exists", insertedId: null });
      }

      // Default fields for HR
      if (user.role === "hr") {
        user.packageLimit = 5;
        user.currentEmployees = 0;
        user.subscription = "basic";
        user.companyLogo = user.companyLogo || "";
      }

      user.createdAt = new Date();
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    // Get User Role
    app.get("/users/role/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      if (email !== req.decoded.email) {
        return res.status(403).send({ message: "forbidden access" });
      }
      const query = { email: email };
      const user = await usersCollection.findOne(query);
      res.send({ role: user?.role || "employee" });
    });

    // Get User Profile (Common)
    app.get("/users/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      const query = { email: email };
      const result = await usersCollection.findOne(query);
      res.send(result);
    });

    // ==============================================================
    // 📦 ASSET MANAGEMENT APIs (HR & Common)
    // ==============================================================

    // Add Asset (HR Only)
    app.post("/assets", verifyToken, verifyHR, async (req, res) => {
      const asset = req.body;
      asset.dateAdded = new Date();
      asset.productQuantity = parseInt(asset.productQuantity);

      // Available quantity starts equal to product quantity
      // (Requirement says: availableQuantity = calculated? But storing it makes query easier)
      // We will track quantity changes directly in productQuantity for simplicity
      // OR separate availableQuantity if we want to track total vs available.
      // Let's stick to: productQuantity is the CURRENT available stock.

      const result = await assetsCollection.insertOne(asset);
      res.send(result);
    });

    // Get Assets (List with Search, Filter & Pagination)
    // Logic: If HR email provided -> HR's assets. Else -> All available assets (for Employees)
    app.get("/assets", verifyToken, async (req, res) => {
      const { search, filter, email, page = 0, limit = 10 } = req.query;

      let query = {};

      // If HR email is present, filter by owner
      if (email) {
        query.hrEmail = email;
      } else {
        // For employees/public: only show assets with quantity > 0
        query.productQuantity = { $gt: 0 };
      }

      // Search by Product Name
      if (search) {
        query.productName = { $regex: search, $options: "i" };
      }

      // Filter by Type (Returnable/Non-returnable)
      if (filter) {
        query.productType = filter;
      }

      const skip = parseInt(page) * parseInt(limit);

      const result = await assetsCollection
        .find(query)
        .skip(skip)
        .limit(parseInt(limit))
        .sort({ dateAdded: -1 }) // Newest first
        .toArray();

      res.send(result);
    });

    // Get Single Asset
    app.get("/assets/:id", verifyToken, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await assetsCollection.findOne(query);
      res.send(result);
    });

    // Delete Asset (HR Only)
    app.delete("/assets/:id", verifyToken, verifyHR, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await assetsCollection.deleteOne(query);
      res.send(result);
    });

    // Update Asset (HR Only)
    app.patch("/assets/:id", verifyToken, verifyHR, async (req, res) => {
      const id = req.params.id;
      const filter = { _id: new ObjectId(id) };
      const updatedDoc = {
        $set: req.body,
      };
      const result = await assetsCollection.updateOne(filter, updatedDoc);
      res.send(result);
    });

    // ==============================================================
    // 🙋 REQUEST & AFFILIATION APIs
    // ==============================================================

    // Employee Requests an Asset
    app.post("/request-asset", verifyToken, async (req, res) => {
      const requestData = req.body;
      requestData.requestDate = new Date();
      requestData.requestStatus = "pending";

      // Basic check if asset exists & available
      // (Advanced: Check quantity > 0 here again for safety)

      const result = await requestsCollection.insertOne(requestData);
      res.send(result);
    });

    // Get Requests for HR (All requests for My Assets)
    app.get("/requests/hr/:email", verifyToken, verifyHR, async (req, res) => {
      const email = req.params.email;
      const { search } = req.query; // Search by requester name or email

      let query = { hrEmail: email };

      if (search) {
        query.$or = [
          { requesterName: { $regex: search, $options: "i" } },
          { requesterEmail: { $regex: search, $options: "i" } },
        ];
      }

      const result = await requestsCollection.find(query).toArray();
      res.send(result);
    });

    // Get Requests for Employee (My Requests)
    app.get("/requests/my-requests/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      const { search } = req.query; // Search by asset name

      let query = { requesterEmail: email };

      if (search) {
        query.assetName = { $regex: search, $options: "i" };
      }

      const result = await requestsCollection.find(query).toArray();
      res.send(result);
    });

    // HR Handles Request (Approve / Reject) - THE CORE LOGIC
    app.patch("/requests/:id", verifyToken, verifyHR, async (req, res) => {
      const id = req.params.id;
      const { status } = req.body; // 'approved' or 'rejected'

      // 1. Update Request Status
      const filter = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          requestStatus: status,
          approvalDate: new Date(),
        },
      };

      const request = await requestsCollection.findOne(filter);
      if (!request)
        return res.status(404).send({ message: "Request not found" });

      const result = await requestsCollection.updateOne(filter, updateDoc);

      // 2. If Approved: Perform Side Effects
      if (status === "approved") {
        // A. Decrease Asset Quantity
        const assetFilter = { _id: new ObjectId(request.assetId) };
        await assetsCollection.updateOne(assetFilter, {
          $inc: { productQuantity: -1 },
        });

        // B. Add to Assigned Assets Collection (For easy tracking)
        const assignedAsset = {
          assetId: request.assetId,
          assetName: request.assetName,
          assetType: request.assetType,
          assetImage: request.assetImage || "", // Assuming image passed in request or fetch from asset
          employeeEmail: request.requesterEmail,
          employeeName: request.requesterName,
          hrEmail: request.hrEmail,
          companyName: request.companyName,
          assignmentDate: new Date(),
          status: "assigned",
        };
        await assignedAssetsCollection.insertOne(assignedAsset);

        // C. Auto-Affiliation Logic (Check if user already in team)
        const affiliationQuery = {
          employeeEmail: request.requesterEmail,
          hrEmail: request.hrEmail,
        };
        const existingAffiliation =
          await employeeAffiliationsCollection.findOne(affiliationQuery);

        if (!existingAffiliation) {
          // Fetch HR Info to get Logo/Company Details properly if needed
          const hrUser = await usersCollection.findOne({
            email: request.hrEmail,
          });

          const newAffiliation = {
            employeeEmail: request.requesterEmail,
            employeeName: request.requesterName,
            hrEmail: request.hrEmail,
            companyName: request.companyName,
            companyLogo: hrUser?.companyLogo || "",
            role: "employee",
            affiliationDate: new Date(),
          };

          // Update HR's employee count
          await usersCollection.updateOne(
            { email: request.hrEmail },
            { $inc: { currentEmployees: 1 } }
          );

          await employeeAffiliationsCollection.insertOne(newAffiliation);
        }
      }

      res.send(result);
    });

    // Employee Returns Asset (Optional Feature)
    app.patch("/return-asset/:id", verifyToken, async (req, res) => {
      const id = req.params.id; // assignedAsset ID or Request ID? Let's assume Request ID or Assigned ID.
      // For simplicity, let's assume we handle return on the 'assignedAssets' document

      // Update assignedAsset status
      const result = await assignedAssetsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: "returned", returnDate: new Date() } }
      );

      // Increase Asset Quantity
      // (We need to find the assetId first from the assigned doc)
      const assignedDoc = await assignedAssetsCollection.findOne({
        _id: new ObjectId(id),
      });
      if (assignedDoc) {
        await assetsCollection.updateOne(
          { _id: new ObjectId(assignedDoc.assetId) },
          { $inc: { productQuantity: 1 } }
        );
      }

      res.send(result);
    });

    // ==============================================================
    // 👥 TEAM & AFFILIATION LIST APIs
    // ==============================================================

    // Get My Team (For Employee) - Shows other employees in same company
    app.get("/my-team/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      // 1. Find which companies this employee is in
      const affiliations = await employeeAffiliationsCollection
        .find({ employeeEmail: email })
        .toArray();

      // 2. For each company (HR), find all employees
      // (Simplified: Just showing list of colleagues from the FIRST affiliated company or via query param)
      // Let's assume frontend sends ?hrEmail=... to filter specific team

      const { hrEmail } = req.query;
      if (!hrEmail) return res.send([]); // Must select a company

      const teamMembers = await employeeAffiliationsCollection
        .find({ hrEmail: hrEmail })
        .toArray();
      res.send(teamMembers);
    });

    // Get My Employees (For HR)
    app.get("/my-employees/:email", verifyToken, verifyHR, async (req, res) => {
      const email = req.params.email;
      const result = await employeeAffiliationsCollection
        .find({ hrEmail: email })
        .toArray();
      res.send(result);
    });

    // Remove Employee from Team (HR Only)
    app.delete(
      "/remove-employee/:id",
      verifyToken,
      verifyHR,
      async (req, res) => {
        // id is the Affiliation ID
        const id = req.params.id;

        // Find affiliation to get details before delete
        const affiliation = await employeeAffiliationsCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!affiliation)
          return res.status(404).send({ message: "Affiliation not found" });

        // 1. Delete Affiliation
        const deleteResult = await employeeAffiliationsCollection.deleteOne({
          _id: new ObjectId(id),
        });

        // 2. Decrease HR employee count
        await usersCollection.updateOne(
          { email: affiliation.hrEmail },
          { $inc: { currentEmployees: -1 } }
        );

        // 3. Optional: Logic to return all assets?
        // For now, we leave assigned assets as history or handle separately.

        res.send(deleteResult);
      }
    );

    // ==============================================================
    // 💳 PAYMENT APIs (Stripe)
    // ==============================================================

    app.post(
      "/create-payment-intent",
      verifyToken,
      verifyHR,
      async (req, res) => {
        const { price } = req.body;
        const amount = parseInt(price * 100); // Convert to cents

        const paymentIntent = await stripe.paymentIntents.create({
          amount: amount,
          currency: "usd",
          payment_method_types: ["card"],
        });

        res.send({
          clientSecret: paymentIntent.client_secret,
        });
      }
    );

    // Save Payment Info & Update Package
    app.post("/payments", verifyToken, verifyHR, async (req, res) => {
      const payment = req.body;
      // payment object should contain: { hrEmail, amount, transactionId, newPackageLimit, ... }

      const paymentResult = await paymentsCollection.insertOne(payment);

      // Update HR Package Limit
      const filter = { email: payment.hrEmail };
      const updateDoc = {
        $set: { packageLimit: payment.newPackageLimit }, // e.g. 10 or 20
      };
      const updateResult = await usersCollection.updateOne(filter, updateDoc);

      res.send({ paymentResult, updateResult });
    });

    app.get("/admin-stats", verifyToken, verifyHR, async (req, res) => {
      const email = req.decoded.email; // HR Email

      // 1. Returnable vs Non-Returnable Count
      const returnableCount = await assetsCollection.countDocuments({
        hrEmail: email,
        productType: "Returnable",
      });
      const nonReturnableCount = await assetsCollection.countDocuments({
        hrEmail: email,
        productType: "Non-returnable",
      });

      // 2. Top requested assets (Aggregation)
      // Group by assetName and count requests
      const topRequests = await requestsCollection
        .aggregate([
          { $match: { hrEmail: email } },
          { $group: { _id: "$assetName", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 5 },
        ])
        .toArray();

      res.send({
        pieChartData: [
          { name: "Returnable", value: returnableCount },
          { name: "Non-returnable", value: nonReturnableCount },
        ],
        topRequests,
      });
    });

    console.log("📌 AssetVerse Database & ALL Routes Ready!");
  } finally {
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("AssetVerse Server is Running");
});

app.listen(port, () => {
  console.log(`🚀 Server is running on port: ${port}`);
});
