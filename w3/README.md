# Shared Minds - Real-time Collaborative Thinking

A real-time collaborative platform where multiple users can share their thoughts through voice recognition and see them visualized as expanding ripples on a shared canvas.

## New Features (Compared to w2)

### 🌐 **Real-time Collaboration**

- Multiple users can connect simultaneously and share their thoughts in real-time
- All connected users see each other's thoughts appear instantly on their screens
- Live user count display showing how many people are currently connected

### 🔗 **Server Architecture**

- **Backend**: Node.js + Express server for handling real-time communication
- **Real-time Communication**: Socket.io for instant message broadcasting
- **Memory Storage**: In-memory JSON storage (resets when server restarts)
- **Connection Status**: Visual indicators showing server connection status

## Local Development

1. Install dependencies:

```bash
npm install
```

2. Start the server:

```bash
npm start
```

3. Open `http://localhost:3000` in your browser

## Railway Deployment

1. Create a [Railway](https://railway.app) account
2. Connect your GitHub repository
3. Automatic deployment will complete

## How It Works

1. **Voice Input**: Click the mic button to start voice recognition
2. **Text Processing**: Spoken words are converted to text and sent to the server
3. **Real-time Sharing**: All connected users receive the text instantly
4. **Visualization**: Text appears as expanding ripples with translation rings
5. **Auto-fade**: Thoughts fade out after ~15 seconds
