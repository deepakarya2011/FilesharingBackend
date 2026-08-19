// .env file se environment variables load karo (jaise PORT, DATABASE_URL, FRONTEND_URL).
// Yeh line sabse pehle honi chahiye taaki baaki code mein process.env available ho.
require("dotenv").config();

// Express — Node.js ka web framework. HTTP routes aur middleware handle karta hai.
const express = require("express");

// CORS — Cross-Origin Resource Sharing. Frontend (localhost:5173) ko backend
// (localhost:5000) pe request karne ki permission deta hai.
const cors = require("cors");

// Node.js ka built-in http module. Hum isse Express app ke upar ek raw HTTP server
// banate hain, kyunki Socket.IO ko same server pe attach karna hota hai.
const http = require("http");

// Socket.IO ka Server class. Yeh real-time, bidirectional communication enable karta hai
// browser aur server ke beech — WebRTC signaling ke liye use hoga.
const { Server } = require("socket.io");

// Hamara Prisma client instance — Neon PostgreSQL se baat karta hai.
const prisma = require("./lib/prisma");

// Share-related REST API routes (create share, verify code, save file metadata).
const shareRoutes = require("./routes/shareRoutes");

// Express app banao.
const app = express();

// Express app ko http.createServer mein wrap karo.
// Yeh zaroori hai kyunki Socket.IO ko ek raw http.Server chahiye hota hai,
// sirf Express app nahi.
const server = http.createServer(app);

// Socket.IO server banao aur http server se attach karo.
// cors option se frontend URL ko WebSocket connections ki permission milti hai.
const io = new Server(server, {
    cors: { origin: process.env.FRONTEND_URL }
});


// ================================
// MIDDLEWARE
// ================================

// Sirf FRONTEND_URL se aane wali HTTP requests allow karo.
app.use(cors({ origin: process.env.FRONTEND_URL }));

// Incoming JSON request bodies parse karo (e.g. { code: "123456" }).
app.use(express.json());


// ================================
// REST ROUTES
// ================================

// Saare share-related REST routes /api/shares prefix ke saath mount karo.
// Actual route handlers shareRoutes.js mein hain.
app.use("/api/shares", shareRoutes);


// ================================
// SOCKET.IO SIGNALING
// ================================
// WebRTC peer-to-peer connection ke liye sender aur receiver ko ek doosre ke saath
// SDP offer/answer aur ICE candidates exchange karne hote hain.
// Yeh directly nahi ho sakta — dono browsers ek doosre ka address nahi jaante.
// Isliye hum Socket.IO ko "signaling server" ki tarah use karte hain:
// ek middleman jo messages forward karta hai dono peers ke beech.
//
// Flow:
// 1. Sender joins room → receiver joins room
// 2. Server sender ko batata hai ki receiver ready hai
// 3. Sender WebRTC offer banata hai → server receiver ko forward karta hai
// 4. Receiver answer banata hai → server sender ko forward karta hai
// 5. Dono ICE candidates exchange karte hain → direct P2P connection ban jaati hai
// 6. Ab files directly browser-to-browser transfer hoti hain (server se nahi guzarti)

io.on("connection", (socket) => {
    // Har naya browser connection yahan aata hai.
    // socket = ek specific browser connection ka object.

    // ---- SENDER JOIN ----
    // Sender "SEND FILES" button dabane ke baad yeh emit karta hai.
    // socket.join(shareId) — sender ko ek room mein daalta hai jiska naam shareId hai.
    // Isse sender aur receiver ek hi "room" mein hote hain aur messages share kar sakte hain.
    // DB mein senderPeerId save karte hain taaki pata rahe kaun sender tha.
    socket.on("sender:join", async ({ shareId }) => {
        socket.join(shareId);
        await prisma.share.update({
            where: { id: shareId },
            data: { senderPeerId: socket.id }
        });
    });

    // ---- RECEIVER JOIN ----
    // Receiver code verify karne ke baad yeh emit karta hai.
    // Receiver bhi usi room mein join hota hai jisme sender hai.
    // DB mein receiverPeerId save karte hain.
    // Phir sender ko "receiver:ready" event bhejte hain taaki woh offer banana shuru kare.
    socket.on("receiver:join", async ({ shareId }) => {
        socket.join(shareId);
        await prisma.share.update({
            where: { id: shareId },
            data: { receiverPeerId: socket.id }
        });
        // socket.to(shareId) — usi room ke baaki sabko bhejo (sender ko).
        socket.to(shareId).emit("receiver:ready");
    });

    // ---- SIGNAL: OFFER ----
    // Sender ne RTCPeerConnection.createOffer() se SDP offer banaya.
    // Hum ise receiver ko forward karte hain.
    // SDP (Session Description Protocol) — connection ki capabilities describe karta hai
    // jaise supported codecs, network info etc.
    socket.on("signal:offer", ({ shareId, offer }) => {
        socket.to(shareId).emit("signal:offer", { offer });
    });

    // ---- SIGNAL: ANSWER ----
    // Receiver ne offer receive karke RTCPeerConnection.createAnswer() se answer banaya.
    // Hum ise sender ko forward karte hain.
    socket.on("signal:answer", ({ shareId, answer }) => {
        socket.to(shareId).emit("signal:answer", { answer });
    });

    // ---- SIGNAL: ICE CANDIDATE ----
    // ICE (Interactive Connectivity Establishment) candidates — network paths hain
    // jisse dono peers ek doosre tak pahunch sakte hain (IP address + port).
    // Dono sides apne candidates generate karte hain aur doosre ko bhejte hain.
    // Jab match milta hai tab direct P2P connection establish hoti hai.
    socket.on("signal:ice", ({ shareId, candidate }) => {
        socket.to(shareId).emit("signal:ice", { candidate });
    });

    // ---- TRANSFER DONE ----
    // Sender saari files bhejne ke baad yeh emit karta hai.
    // DB mein share status "completed" update karte hain taaki dobara use na ho sake.
    // Phir dono peers ko "transfer:done" event bhejte hain.
    socket.on("transfer:done", async ({ shareId }) => {
        await prisma.share.update({
            where: { id: shareId },
            data: { status: "completed" }
        });
        io.to(shareId).emit("transfer:done");
    });
});


// Simple health check route — confirm karta hai ki server chal raha hai.
app.get("/", (req, res) => res.send("FileShare Backend Running"));


// ================================
// START SERVER
// ================================

// .env se PORT lo, nahi mila to 5000 use karo.
// app.listen() ki jagah server.listen() use karo kyunki Socket.IO
// http.Server se attached hai, Express app se nahi.
const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
