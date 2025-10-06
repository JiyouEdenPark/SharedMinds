// Firebase client initialization for SharedMinds w5
// Loads Firebase modular SDK from CDN.

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.3.0/firebase-app.js";
import {
    initializeFirestore,
    collection,
    addDoc,
    serverTimestamp,
    onSnapshot,
    query,
    orderBy,
    doc,
    updateDoc,
    getDocs,
    where,
    limit
} from "https://www.gstatic.com/firebasejs/12.3.0/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyDRZWnILme22vJWuOUqmfmAByIE1JMvMnY",
    authDomain: "ripple-a1e6e.firebaseapp.com",
    projectId: "ripple-a1e6e",
    storageBucket: "ripple-a1e6e.firebasestorage.app",
    messagingSenderId: "33532902199",
    appId: "1:33532902199:web:33fbdc8c7ebcc17fa238b2",
    measurementId: "G-YCPJK2Q30H"
};

const app = initializeApp(firebaseConfig);
// More tolerant networking for environments that block WebChannel
const db = initializeFirestore(app, {
    experimentalAutoDetectLongPolling: true,
    useFetchStreams: false,
});

export {
    db,
    collection,
    addDoc,
    serverTimestamp,
    onSnapshot,
    query,
    orderBy,
    doc,
    updateDoc,
    getDocs,
    where,
    limit
};


