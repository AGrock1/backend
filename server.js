const express = require('express');
const admin = require('firebase-admin');
const twilio = require('twilio');
const { Resend } = require('resend');

const app = express();
const port = process.env.PORT || 3000;

// Initialize APIs
const resend = new Resend(process.env.RESEND_API_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Parse Firebase Service Account
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});

const db = admin.database();
const activeAlarms = {}; // Tracks active incidents to prevent duplicate alerts

// Listen for telemetry updates across all devices
db.ref('/devices').on('child_changed', async (snapshot) => {
    const deviceMac = snapshot.key;
    const telemetry = snapshot.child('telemetry').val();
    
    // Check if alarm just triggered and hasn't been handled yet
    if (telemetry && telemetry.alarm_triggered === true && !activeAlarms[deviceMac]) {
        activeAlarms[deviceMac] = true;
        console.log(`Alarm triggered on device: ${deviceMac}`);
        
        // Find the user who registered this device
        const usersRef = await db.ref('/users').once('value');
        let profile = null;
        
        usersRef.forEach((userSnap) => {
            if (userSnap.child('active_device').val() === deviceMac) {
                profile = userSnap.child('profile').val();
            }
        });

        if (profile) sendNotifications(profile);
        
    } else if (telemetry && telemetry.alarm_triggered === false) {
        activeAlarms[deviceMac] = false; // Reset tracking when stove is safe
    }
});

async function sendNotifications(profile) {
    const msg = "⚠️ FORGOTTEN STOVE: Alarm triggered! Go to your kitchen immediately.";
    
    // Send SMS
    if ((profile.alert_preference === 'sms' || profile.alert_preference === 'both') && profile.phone) {
        try {
            await twilioClient.messages.create({
                body: msg,
                from: process.env.TWILIO_PHONE_NUMBER,
                to: profile.phone
            });
            console.log("SMS sent successfully.");
        } catch (err) { console.error("Twilio Error:", err); }
    }
    
    // Send Email
    if ((profile.alert_preference === 'email' || profile.alert_preference === 'both') && profile.email) {
        try {
            await resend.emails.send({
                from: 'onboarding@resend.dev', // Replace with alerts@ahmedghazanfar.com if you verify your domain in Resend
                to: profile.email,
                subject: '⚠️ STOVE ALARM ACTIVATED',
                html: `<h2>Emergency Alert</h2><p>${msg}</p>`
            });
            console.log("Email sent successfully.");
        } catch (err) { console.error("Resend Error:", err); }
    }
}

// HTTP endpoint to keep the server awake
app.get('/ping', (req, res) => res.status(200).send('Awake'));

app.listen(port, () => console.log(`Backend running on port ${port}`));