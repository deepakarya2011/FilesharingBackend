// MongoDB connection (Mongoose).
// Connection string .env mein MONGODB_URI se aati hai.
// Database ka naam hamesha "filesharing" hota hai (URI ke path se independent).
const mongoose = require("mongoose");

// Database name — default "filesharing" (env se override kar sakte ho).
const DB_NAME = process.env.MONGODB_DB_NAME || "filesharing";

const connectDB = async () => {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
        throw new Error("MONGODB_URI is not set in .env — MongoDB connect karne ke liye connection string daalo.");
    }
    if (!/^mongodb(\+srv)?:\/\//.test(uri)) {
        throw new Error("MONGODB_URI invalid form hai — 'mongodb+srv://...' ya 'mongodb://...' se shuru hona chahiye (Atlas se puri string copy karo).");
    }

    await mongoose.connect(uri, {
        dbName: DB_NAME,            // Database name force karo: filesharing
        serverSelectionTimeoutMS: 10000
    });

    console.log(`MongoDB connected: ${mongoose.connection.host} / database: ${mongoose.connection.name}`);
    return mongoose.connection;
};

const isDBConnected = () =>
    mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2;

module.exports = { connectDB, isDBConnected };