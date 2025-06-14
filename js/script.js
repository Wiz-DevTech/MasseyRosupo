// Navigation and Section Management
function showSection(sectionId) {
    document.querySelectorAll('.content-section').forEach(section => {
        section.classList.remove('active');
    });
    // Hide admin portal if visible
    document.getElementById('admin-portal-section').classList.remove('active');
    document.getElementById('admin-portal-section').style.display = 'none';

    document.getElementById(sectionId).classList.add('active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Form Submission
function submitInquiry() {
    alert('Inquiry submitted. A representative will contact you via secure channels.');
    showSection('overview');
}

// Document Viewer Simulation
function openImmersive(docType) {
    alert(`Opening ${docType.replace(/_/g, ' ')} document...\n\nIn production, this would open the actual document.`);
}

// Set current year in footer
document.getElementById('year').textContent = new Date().getFullYear();

// Initialize to show overview section on load
document.addEventListener('DOMContentLoaded', () => {
    showSection('overview');
});