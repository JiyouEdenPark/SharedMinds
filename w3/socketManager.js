class SocketManager {
  constructor() {
    this.socket = null;
    this.isConnected = false;
    this.connectedUsers = 0;

    this.onConnect = null;
    this.onDisconnect = null;
    this.onTextReceived = null;
    this.onUserCountUpdate = null;
    this.onInitialTexts = null;
  }

  connect() {
    this.socket = io();

    this.socket.on("connect", () => {
      this.isConnected = true;
      if (this.onConnect) this.onConnect();
    });

    this.socket.on("disconnect", () => {
      this.isConnected = false;
      if (this.onDisconnect) this.onDisconnect();
    });

    this.socket.on("initialTexts", (texts) => {
      if (this.onInitialTexts) this.onInitialTexts(texts);
    });

    this.socket.on("textAdded", (textObj) => {
      if (this.onTextReceived) this.onTextReceived(textObj);
    });

    this.socket.on("userCount", (count) => {
      this.connectedUsers = count;
      if (this.onUserCountUpdate) this.onUserCountUpdate(count);
    });
  }

  sendText(text, x, y, translations, id, sentiment = null) {
    if (!this.isConnected || !this.socket) {
      return false;
    }

    this.socket.emit("newText", {
      id: id,
      text: text,
      x: x,
      y: y,
      translations: translations,
      sentiment: sentiment,
    });
    return true;
  }

  getConnectionStatus() {
    return {
      isConnected: this.isConnected,
      userCount: this.connectedUsers,
    };
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.isConnected = false;
  }
}

window.SocketManager = SocketManager;
