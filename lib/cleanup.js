// Cloudinary cleanup helpers — files ko delete karte hain taaki storage clean rahe.
// DB: MongoDB (Mongoose).
const cloudinary = require("./cloudinary");
const Share = require("../models/Share");
const File = require("../models/File");

// Cloudinary se file delete karo — sahi resource_type ke saath.
// Purani files (jor daar resourceType stored nahi hai) ke liye teeno types
// (image→video→raw) try karta hai, taaki raw/video files delete se miss na hon.
const deleteFromCloudinary = async (file) => {
    if (!file || !file.cloudinaryPublicId) return;

    // New records: exact type pata hai — sirf ek call.
    // Old records: resourceType missing/auto — teeno types try karo.
    const types = file.resourceType && file.resourceType !== "auto"
        ? [file.resourceType]
        : ["image", "video", "raw"];

    for (const type of types) {
        try {
            const res = await cloudinary.uploader.destroy(file.cloudinaryPublicId, { resource_type: type });
            // "ok" = is type me file thi aur delete ho gayi — return.
            // "not found" = is type me file nahi thi — agli type try karo
            // (files raw/video/image kisi ek type me hi hoti hain).
            if (res && res.result === "ok") return res;
        } catch (e) {
            // galat type pe error aane do — agli type try karo.
        }
    }
    // Koi bhi type successful na ho to warning log karo (DB delete phir bhi hoga).
    console.warn("Cloudinary delete uncertain for", file.cloudinaryPublicId);
};

// Ek single file ko Cloudinary + DB dono se delete karo.
// @param file - Mongoose File document (cloudinaryPublicId chahiye)
const deleteCloudinaryFile = async (file) => {
    if (!file || !file.cloudinaryPublicId) return;

    try {
        // Cloudinary se actual file bytes delete karo (sahi resource_type ke saath).
        await deleteFromCloudinary(file);
    } catch (error) {
        // Agar Cloudinary delete fail ho (file pehle se missing), ignore karo —
        // DB record to delete hona chahiye.
        console.warn("Cloudinary delete failed:", file.cloudinaryPublicId, error.message);
    }

    try {
        // DB se file metadata record delete karo.
        await File.findByIdAndDelete(file._id);
    } catch (error) {
        console.warn("DB file delete failed:", file._id, error.message);
    }
};

// Share ke saari files delete karo (expiry cleanup ke liye).
const deleteShareFiles = async (shareId) => {
    const files = await File.find({ shareId });
    for (const file of files) {
        await deleteCloudinaryFile(file);
    }
};

// Expired shares cleanup — interval se call hota hai (server.js mein).
// Purani files Cloudinary se delete ho jaati hain aur DB records bhi.
const cleanupExpiredShares = async () => {
    const now = new Date();

    const expiredShares = await Share.find({ expiresAt: { $lt: now } });

    for (const share of expiredShares) {
        // Pehle saari files Cloudinary + DB se delete karo.
        await deleteShareFiles(share._id);

        // Phir share record delete karo.
        await Share.findByIdAndDelete(share._id).catch(() => {
            // Agar share already deleted ho to ignore.
        });

        console.log(`Cleaned up expired share #${share._id}`);
    }

    return expiredShares.length;
};

module.exports = { deleteFromCloudinary, deleteCloudinaryFile, deleteShareFiles, cleanupExpiredShares };