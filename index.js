require("dotenv").config();
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 5000;

app.use(
  cors({
    origin: ["http://localhost:5173"], 
    credentials: true,
  })
);
app.use(express.json()); 
app.use(cookieParser());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.xmpl.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    
    console.log(
      "📌 Pinged your deployment. You successfully connected to MongoDB!"
    );

    const db = client.db(process.env.DB_NAME);
    const usersCollection = db.collection("users");
    const assetsCollection = db.collection("assets");
    const requestsCollection = db.collection("requests");
    const employeeAffiliationsCollection = db.collection(
      "employeeAffiliations"
    );
    const packagesCollection = db.collection("packages");
    const paymentsCollection = db.collection("payments");

    
  } finally {
    
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("AssetVerse Server is Running Properly");
});

// --- START SERVER ---
app.listen(port, () => {
  console.log(`🚀 Server is running on port: ${port}`);
});
