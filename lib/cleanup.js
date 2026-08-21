// Cloudinary cleanup helpers — files ko delete karte hain taaki storage clean rahe.
// DB: MongoDB (Mongoose).
const cloudinary = require("./cloudinary");
const Share = require("../models/Share");
const File = require("../models/File");

// Ek single file ko Cloudinary + DB dono se delete karo.
// @param file - Mongoose File document (cloudinaryPublicId chahiye)
const deleteCloudinaryFile = async (file) => {
    if (!file || !file.cloudinaryPublicId) return;

    try {
        // Cloudinary se actual file bytes delete karo.
        await cloudinary.uploader.destroy(file.cloudinaryPublicId);
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

module.exports = { deleteCloudinaryFile, deleteShareFiles, cleanupExpiredShares };