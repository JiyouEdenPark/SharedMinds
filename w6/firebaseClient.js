// Firebase client initialization for SharedMinds w6
// Loads Firebase modular SDK from CDN.

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.3.0/firebase-app.js";
import {
    initializeFirestore,
    collection,
    addDoc,
    setDoc,
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
import {
    getAuth,
    onAuthStateChanged,
    signInWithPopup,
    GoogleAuthProvider,
    signInAnonymously,
    signOut,
    signInWithRedirect,
    getRedirectResult
} from "https://www.gstatic.com/firebasejs/12.3.0/firebase-auth.js";

const firebaseConfig = {
    apiKey: "AIzaSyAyI-53gPIpb-qTPCF7diOQPTGvCtEU7q4",
    authDomain: "rippling-d6a1a.firebaseapp.com",
    projectId: "rippling-d6a1a",
    storageBucket: "rippling-d6a1a.firebasestorage.app",
    messagingSenderId: "331516321101",
    appId: "1:331516321101:web:e5fa9e68cdcfbfd5102b04"
};

const app = initializeApp(firebaseConfig);
// More tolerant networking for environments that block WebChannel
const db = initializeFirestore(app, {
    experimentalAutoDetectLongPolling: true,
    useFetchStreams: false,
});
const auth = getAuth(app);

export {
    db,
    auth,
    collection,
    addDoc,
    setDoc,
    serverTimestamp,
    onSnapshot,
    query,
    orderBy,
    doc,
    updateDoc,
    getDocs,
    where,
    limit,
    // auth helpers
    onAuthStateChanged,
    signInWithPopup,
    GoogleAuthProvider,
    signInAnonymously,
    signOut,
    signInWithRedirect,
    getRedirectResult
};


