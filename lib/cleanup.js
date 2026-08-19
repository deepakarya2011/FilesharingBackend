// Cloudinary cleanup helpers — files ko delete karte hain taaki storage clean rahe.
const cloudinary = require("./cloudinary");
const prisma = require("./prisma");

// Ek single file ko Cloudinary + DB dono se delete karo.
// @param file - Prisma File record (cloudinaryPublicId chahiye)
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
        await prisma.file.delete({
            where: { id: file.id }
        });
    } catch (error) {
        console.warn("DB file delete failed:", file.id, error.message);
    }
};

// Share ke saari files delete karo (expiry cleanup ke liye).
const deleteShareFiles = async (shareId) => {
    const files = await prisma.file.findMany({ where: { shareId } });
    for (const file of files) {
        await deleteCloudinaryFile(file);
    }
};

// Expired shares cleanup — interval se call hota hai (server.js mein).
// Purani files Cloudinary se delete ho jaati hain aur DB records bhi.
const cleanupExpiredShares = async () => {
    const now = new Date();

    const expiredShares = await prisma.share.findMany({
        where: {
            expiresAt: { lt: now }
        },
        include: { files: true }
    });

    for (const share of expiredShares) {
        // Pehle saari files Cloudinary + DB se delete karo.
        for (const file of share.files) {
            await deleteCloudinaryFile(file);
        }

        // Phir share record delete karo.
        await prisma.share.delete({
            where: { id: share.id }
        }).catch(() => {
            // Agar share already deleted ho to ignore.
        });

        console.log(`Cleaned up expired share #${share.id}`);
    }

    return expiredShares.length;
};

module.exports = { deleteCloudinaryFile, deleteShareFiles, cleanupExpiredShares };