require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const chatRoutes = require('./routes');
const socketHandler = require('./socketHandler');

const app = express();
app.use(cors());
app.use(express.json());

// ربط الـ API routes
app.use('/api/chat', chatRoutes);

// إعداد السيرفر
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" } 
});

// تفعيل السوكيت
socketHandler(io);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Chat Server running on port ${PORT}`);
});