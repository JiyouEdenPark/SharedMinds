# Shared Minds - AI-Powered Collaborative Thinking

A real-time collaborative platform where multiple users can share their thoughts through voice recognition and see them visualized as expanding ripples on a shared canvas, with AI-powered brain hemisphere analysis and multi-language translation.

## ✨ **Key Features**

### 🧠 **AI-Powered Brain Hemisphere Analysis**
- Real-time analysis of thinking style using AI (left brain vs right brain)
- Left brain (logical) thoughts float in the left screen area, right brain (creative) thoughts float in the right screen area
- Automatic brain hemisphere classification with confidence scores
- Smart zone-based movement that guides texts to their designated areas

### 🌍 **Multi-Language Support**
- Automatic language detection and translation
- Support for Korean, Japanese, and English
- Click on floating texts to cycle through different language versions
- Smart language switching (removes duplicate languages)

### 🌐 **Real-time Collaboration**
- Multiple users can connect simultaneously and share their thoughts in real-time
- All connected users see each other's thoughts appear instantly on their screens
- Live user count display showing how many people are currently connected
- Prevent duplicate display of your own messages

### 🎨 **Dynamic Visualization**
- Thoughts appear as expanding ripples with character-based animations
- Screen divided into left and right zones for brain hemisphere-based movement
- Auto-fade system with 50-second duration (30-second floating + 20-second fade)
- Smooth animations and visual effects with intelligent zone navigation

### 🔗 **Server Architecture**
- **Backend**: Node.js + Express server for handling real-time communication
- **Real-time Communication**: Socket.io for instant message broadcasting
- **Memory Management**: Automatic cleanup of old messages (50-second retention)
- **AI Integration**: ProxyAI for brain hemisphere analysis
- **ASR Integration**: Whisper API for voice recognition

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

1. **Voice Input**: Click the mic button to start voice recognition using Whisper API
2. **AI Analysis**: Text is analyzed for brain hemisphere thinking style using AI (left brain vs right brain)
3. **Translation**: Automatic translation to Korean, Japanese, and English
4. **Real-time Sharing**: All connected users receive the text instantly with brain hemisphere data
5. **Dynamic Visualization**: 
   - Text appears as expanding ripples with character-based animations
   - Screen divided into left and right zones for brain hemisphere-based movement
   - Left brain (logical) thoughts float in the left zone, right brain (creative) thoughts float in the right zone
   - Intelligent zone navigation guides texts to their designated areas
   - Click on floating texts to cycle through different language versions
6. **Auto-cleanup**: Thoughts automatically fade out after 50 seconds (30-second floating + 20-second fade)

## Technical Stack

- **Frontend**: HTML5 Canvas, JavaScript ES6+, CSS3
- **Backend**: Node.js, Express.js
- **Real-time**: Socket.io
- **AI Services**: ProxyAI for brain hemisphere analysis
- **Voice Recognition**: Whisper API via Replicate
- **Translation**: MyMemory Translation API
- **Deployment**: Railway.app
