// Import the functions you need from the SDKs you need
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.8.1/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/11.8.1/firebase-analytics.js";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.8.1/firebase-auth.js";

// Your web app's Firebase configuration
const firebaseConfig = {
    apiKey: "AIzaSyDk1aI9-DdMhlOWERu2RVYYpURBy_-DW5o",
    authDomain: "masseyrosupo.firebaseapp.com",
    projectId: "masseyrosupo",
    storageBucket: "masseyrosupo.firebasestorage.app",
    messagingSenderId: "335180500143",
    appId: "1:335180500143:web:12b7e6f3778ad706cc585a",
    measurementId: "G-TLVDZ69BVC"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
const auth = getAuth(app);

// Authentication State Listener
onAuthStateChanged(auth, (user) => {
    if (user) {
        // User is signed in
        const userAvatar = document.querySelector('.user-avatar');
        const userName = document.querySelector('.user-info span');
        
        // Set initials for avatar
        const initials = user.email.charAt(0).toUpperCase();
        if (userAvatar) userAvatar.textContent = initials;
        
        // Display email (or name if you have it)
        if (userName) userName.textContent = user.email;
        
        handleSuccessfulLogin();
        
        // If we're on index.html, show the admin portal section
        if (window.location.pathname.endsWith('index.html')) {
            showSection('admin-portal-section');
        }
    } else {
        // No user is signed in
        handleLogout();
        
        // If we're not on index.html, redirect there with login hash
        if (!window.location.pathname.endsWith('index.html')) {
            window.location.href = 'index.html#login';
        } else {
            // If already on index.html, just show login section
            window.location.hash = '#login';
        }
    }
});


// Make functions available globally
window.login = async function() {
    const email = document.getElementById("username").value;
    const password = document.getElementById("password").value;
    const errorMessage = document.getElementById("errorMessage");
    const loginForm = document.getElementById("login-form");
    const loadingSpinner = document.getElementById("login-loading");

    loginForm.style.display = "none";
    loadingSpinner.style.display = "block";
    errorMessage.style.display = "none";

    try {
        await signInWithEmailAndPassword(auth, email, password);
    } catch (error) {
        errorMessage.textContent = getFirebaseErrorMessage(error);
        errorMessage.style.display = "block";
        loginForm.style.display = "block";
        loadingSpinner.style.display = "none";
    }
};

window.logout = async function() {
    try {
        await signOut(auth);
    } catch (error) {
        console.error("Logout error:", error);
    }
};

function getFirebaseErrorMessage(error) {
    switch (error.code) {
        case 'auth/invalid-email': return 'Invalid email address';
        case 'auth/user-disabled': return 'Account disabled';
        case 'auth/user-not-found': return 'Account not found';
        case 'auth/wrong-password': return 'Incorrect password';
        case 'auth/too-many-requests': return 'Too many attempts';
        default: return 'Login failed. Please try again.';
    }
}

window.handleSuccessfulLogin = function() {
    document.getElementById("admin-portal-section").classList.add("active");
    document.getElementById("admin-portal-section").style.display = "block";
    document.getElementById("login").classList.remove("active");
    document.getElementById("login-nav-item").style.display = "none";
    document.getElementById("logout-nav-item").style.display = "block";
    document.getElementById("login-form").style.display = "block";
    document.getElementById("login-loading").style.display = "none";
};

window.handleLogout = function() {
    // Hide admin-specific elements
    document.getElementById("admin-portal-section").classList.remove("active");
    document.getElementById("admin-portal-section").style.display = "none";
    
    // Reset navigation items
    document.getElementById("login-nav-item").style.display = "block";
    document.getElementById("logout-nav-item").style.display = "none";
    
    // Clear any form data
    const loginForm = document.getElementById("login-form");
    if (loginForm) loginForm.reset();
    
    // Clear any error messages
    const errorMessage = document.getElementById("errorMessage");
    if (errorMessage) {
        errorMessage.style.display = "none";
        errorMessage.textContent = "";
    }
    
    // Reset URL hash if present
    if (window.location.hash) {
        window.history.replaceState(null, null, ' ');
    }
    
    // Show default public section with smooth transition
    setTimeout(() => {
        showSection('overview');
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }, 100);
    
    // Clear any user-specific UI elements
    const userAvatar = document.querySelector('.user-avatar');
    const userName = document.querySelector('.user-info span');
    if (userAvatar) userAvatar.textContent = '';
    if (userName) userName.textContent = '';
    
    // Force a hard refresh if needed (uncomment if you're having state issues)
    // window.location.reload(true);
};