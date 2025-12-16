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
    origin: true,
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());

// --- CUSTOM MIDDLEWARES ---
const verifyToken = (req, res, next) => {
  if (!req.headers.authorization) {
    return res.status(401).send({ message: "unauthorized access" });
  }
  const token = req.headers.authorization.split(" ")[1];
  if (!token) {
    return res.status(401).send({ message: "unauthorized access" });
  }
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(401).send({ message: "unauthorized access" });
    }
    req.decoded = decoded;
    next();
  });
};

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
    const assignedAssetsCollection = db.collection("assignedAssets");
    const paymentsCollection = db.collection("payments");

    // --- VERIFY HR MIDDLEWARE ---
    const verifyHR = async (req, res, next) => {
      try {
        const email = req.decoded.email;
        const query = { email: email };
        const user = await usersCollection.findOne(query);
        const isHR = user?.role === "hr";
        if (!isHR) {
          return res.status(403).send({ message: "forbidden access" });
        }
        next();
      } catch (error) {
        res
          .status(500)
          .send({ message: "Internal Server Error during HR Verification" });
      }
    };

    app.post("/jwt", async (req, res) => {
      const user = req.body;
      const token = jwt.sign(user, process.env.JWT_SECRET, { expiresIn: "1h" });
      res.send({ token });
    });

    app.post("/users", async (req, res) => {
      const user = req.body;
      const query = { email: user.email };
      const existingUser = await usersCollection.findOne(query);
      if (existingUser) {
        return res.send({ message: "user already exists", insertedId: null });
      }
      // Default configurations for HR
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

    app.get("/users/role/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      if (email !== req.decoded.email) {
        return res.status(403).send({ message: "forbidden access" });
      }
      const query = { email: email };
      const user = await usersCollection.findOne(query);
      res.send({ role: user?.role || "employee" });
    });

    app.get("/users/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      const result = await usersCollection.findOne({ email: email });
      res.send(result);
    });

    // Add Asset (HR Only)
    app.post("/assets", verifyToken, verifyHR, async (req, res) => {
      const asset = req.body;
      asset.dateAdded = new Date();
      asset.productQuantity = parseInt(asset.productQuantity);
      const result = await assetsCollection.insertOne(asset);
      res.send(result);
    });

    app.get("/assets", verifyToken, async (req, res) => {
      const { search, filter, email, page = 0, limit = 10 } = req.query;
      let query = {};

      if (email) {
        query.hrEmail = email;
      } else {
        query.productQuantity = { $gt: 0 };
      }

      if (search) {
        query.productName = { $regex: search, $options: "i" };
      }
      if (filter) {
        query.productType = filter;
      }

      const skip = parseInt(page) * parseInt(limit);
      const result = await assetsCollection
        .find(query)
        .skip(skip)
        .limit(parseInt(limit))
        .sort({ dateAdded: -1 })
        .toArray();
      res.send(result);
    });

    app.get("/assets/:id", verifyToken, async (req, res) => {
      try {
        const id = req.params.id;
        const result = await assetsCollection.findOne({
          _id: new ObjectId(id),
        });
        res.send(result);
      } catch (error) {
        res.status(400).send({ message: "Invalid ID" });
      }
    });

    app.delete("/assets/:id", verifyToken, verifyHR, async (req, res) => {
      try {
        const id = req.params.id;
        const result = await assetsCollection.deleteOne({
          _id: new ObjectId(id),
        });
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Error deleting asset" });
      }
    });

    // Update Asset (HR Only)
    app.patch("/assets/:id", verifyToken, verifyHR, async (req, res) => {
      try {
        const id = req.params.id;
        const item = req.body;
        const filter = { _id: new ObjectId(id) };

        const updatedDoc = {
          $set: {
            productName: item.productName,
            productType: item.productType,
            productQuantity: parseInt(item.productQuantity),
            productImage: item.productImage,
            description: item.description,
          },
        };
        const result = await assetsCollection.updateOne(filter, updatedDoc);
        res.send(result);
      } catch (error) {
        console.error("Update Error:", error);
        res.status(500).send({ message: "Error updating asset" });
      }
    });
    app.post("/request-asset", verifyToken, async (req, res) => {
      const requestData = req.body;
      requestData.requestDate = new Date();
      requestData.requestStatus = "pending";
      const result = await requestsCollection.insertOne(requestData);
      res.send(result);
    });

    app.get("/requests/hr/:email", verifyToken, verifyHR, async (req, res) => {
      const email = req.params.email;
      const { search } = req.query;
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

    app.get("/requests/my-requests/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      const { search } = req.query;
      let query = { requesterEmail: email };

      if (search) {
        query.assetName = { $regex: search, $options: "i" };
      }
      const result = await requestsCollection.find(query).toArray();
      res.send(result);
    });

    // Handle Request (Approve/Reject)
    app.patch("/requests/:id", verifyToken, verifyHR, async (req, res) => {
      const id = req.params.id;
      const { status } = req.body;
      const filter = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: { requestStatus: status, approvalDate: new Date() },
      };

      const request = await requestsCollection.findOne(filter);
      if (!request)
        return res.status(404).send({ message: "Request not found" });

      const result = await requestsCollection.updateOne(filter, updateDoc);

      if (status === "approved") {
        // Decrease Quantity
        const assetFilter = { _id: new ObjectId(request.assetId) };
        await assetsCollection.updateOne(assetFilter, {
          $inc: { productQuantity: -1 },
        });

        // Add to Assigned Assets
        const assignedAsset = {
          assetId: request.assetId,
          assetName: request.assetName,
          assetType: request.assetType,
          assetImage: request.assetImage || "",
          employeeEmail: request.requesterEmail,
          employeeName: request.requesterName,
          hrEmail: request.hrEmail,
          companyName: request.companyName,
          assignmentDate: new Date(),
          status: "assigned",
        };
        await assignedAssetsCollection.insertOne(assignedAsset);

        const affiliationQuery = {
          employeeEmail: request.requesterEmail,
          hrEmail: request.hrEmail,
        };
        const existingAffiliation =
          await employeeAffiliationsCollection.findOne(affiliationQuery);

        if (!existingAffiliation) {
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

          await usersCollection.updateOne(
            { email: request.hrEmail },
            { $inc: { currentEmployees: 1 } }
          );
          await employeeAffiliationsCollection.insertOne(newAffiliation);
        }
      }
      res.send(result);
    });

    app.patch("/return-asset/:id", verifyToken, async (req, res) => {
      const id = req.params.id;

      const filter = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: { requestStatus: "returned", returnDate: new Date() },
      };
      const result = await requestsCollection.updateOne(filter, updateDoc);

      // 2. Increase Asset Quantity
      const request = await requestsCollection.findOne(filter);
      if (request && request.assetId) {
        await assetsCollection.updateOne(
          { _id: new ObjectId(request.assetId) },
          { $inc: { productQuantity: 1 } }
        );
      }
      res.send(result);
    });

    app.get("/my-team/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      try {
        // Find which HR owns this employee
        const myAffiliation = await employeeAffiliationsCollection.findOne({
          employeeEmail: email,
        });

        if (!myAffiliation) {
          return res.send([]);
        }

        // Find all employees under that HR
        const teamMembers = await employeeAffiliationsCollection
          .find({ hrEmail: myAffiliation.hrEmail })
          .toArray();

        res.send(teamMembers);
      } catch (error) {
        res.status(500).send({ message: "Error fetching team" });
      }
    });

    // My Employees (For HR)
    app.get("/my-employees/:email", verifyToken, verifyHR, async (req, res) => {
      const email = req.params.email;
      const result = await employeeAffiliationsCollection
        .find({ hrEmail: email })
        .toArray();
      res.send(result);
    });

    // Remove Employee (HR)
    app.delete(
      "/remove-employee/:id",
      verifyToken,
      verifyHR,
      async (req, res) => {
        const id = req.params.id;
        const affiliation = await employeeAffiliationsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!affiliation)
          return res.status(404).send({ message: "Affiliation not found" });

        const deleteResult = await employeeAffiliationsCollection.deleteOne({
          _id: new ObjectId(id),
        });

        // Decrease HR employee count
        await usersCollection.updateOne(
          { email: affiliation.hrEmail },
          { $inc: { currentEmployees: -1 } }
        );
        res.send(deleteResult);
      }
    );

    app.get("/admin-stats", verifyToken, verifyHR, async (req, res) => {
      const email = req.decoded.email;

      // Count Returnable
      const returnableCount = await assetsCollection.countDocuments({
        hrEmail: email,
        productType: { $regex: /^Returnable$/i },
      });

      // Count Non-Returnable
      const nonReturnableCount = await assetsCollection.countDocuments({
        hrEmail: email,
        productType: { $regex: /^Non-returnable$/i },
      });

      // Top Requests
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

    app.post(
      "/create-payment-intent",
      verifyToken,
      verifyHR,
      async (req, res) => {
        const { price } = req.body;
        const amount = parseInt(price * 100);
        const paymentIntent = await stripe.paymentIntents.create({
          amount: amount,
          currency: "usd",
          payment_method_types: ["card"],
        });
        res.send({ clientSecret: paymentIntent.client_secret });
      }
    );

    app.post("/payments", verifyToken, verifyHR, async (req, res) => {
      const payment = req.body;
      const paymentResult = await paymentsCollection.insertOne(payment);
      const filter = { email: payment.hrEmail };
      const updateDoc = { $set: { packageLimit: payment.newPackageLimit } };
      const updateResult = await usersCollection.updateOne(filter, updateDoc);
      res.send({ paymentResult, updateResult });
    });

    // Get Payment History (HR Only)
    app.get("/payments/:email", verifyToken, verifyHR, async (req, res) => {
      const query = { hrEmail: req.params.email };
      const result = await paymentsCollection
        .find(query)
        .sort({ date: -1 })
        .toArray();
      res.send(result);
    });

    // console.log("📌 AssetVerse Database & ALL Routes Ready!");
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
