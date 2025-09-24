const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Middleware setup
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Store texts in memory (resets when server restarts)
let sharedTexts = [];
let connectedUsers = 0;

// Function to clean up old texts (older than 60 seconds)
function cleanupOldTexts() {
  const sixtySecondsAgo = Date.now() - 60000; // 60 seconds in milliseconds
  const initialLength = sharedTexts.length;

  sharedTexts = sharedTexts.filter(text => text.timestamp > sixtySecondsAgo);

  const removedCount = initialLength - sharedTexts.length;
  if (removedCount > 0) {
    console.log(`Cleaned up ${removedCount} old texts. Remaining: ${sharedTexts.length}`);
  }
}

// Socket.io connection handling
io.on("connection", (socket) => {
  console.log("New user connected:", socket.id);
  connectedUsers++;

  // Broadcast connected user count
  io.emit("userCount", connectedUsers);

  // Send existing texts
  socket.emit("initialTexts", sharedTexts);

  // Receive new text
  socket.on("newText", (data) => {
    console.log("New text received:", data);

    // Create text object
    const textObject = {
      id: data.id, // Use client-provided ID
      text: data.text,
      translations: data.translations || null, // 클라이언트에서 번역한 결과 저장
      hemisphere: data.hemisphere || { hemisphere: 'right', confidence: 50 }, // 뇌 반구 분석 결과 저장
      timestamp: Date.now(),
      userId: socket.id,
      x: data.x || Math.random() * 800 + 100,
      y: data.y || Math.random() * 600 + 100,
    };

    // Store in memory
    sharedTexts.push(textObject);

    // Broadcast to all clients
    io.emit("textAdded", textObject);

    // Clean up old texts first
    cleanupOldTexts();

    // Memory management: keep only last 100 texts (as backup)
    if (sharedTexts.length > 100) {
      sharedTexts = sharedTexts.slice(-100);
    }
  });

  // Handle disconnection
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    connectedUsers--;
    io.emit("userCount", connectedUsers);
  });
});

// Serve static files
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// API endpoints
app.get("/api/texts", (req, res) => {
  res.json(sharedTexts);
});

app.get("/api/stats", (req, res) => {
  res.json({
    totalTexts: sharedTexts.length,
    connectedUsers: connectedUsers,
  });
});

// Port configuration
const PORT = process.env.PORT || 3000;

// Set up periodic cleanup every 10 seconds
setInterval(cleanupOldTexts, 10000);

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Access at http://localhost:${PORT}`);
});
