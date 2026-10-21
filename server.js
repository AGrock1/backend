const express = require('express');
const admin = require('firebase-admin');
const twilio = require('twilio');
const { Resend } = require('resend');

const app = express();
const port = process.env.PORT || 3000;

// Initialize APIs
const resend = new Resend(process.env.RESEND_API_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
// New Twilio trials accept a template ID, not custom alert text or a From number.
// Set TWILIO_TRIAL_TEMPLATE=sms_internal_alerts for the trial demo.
// Remove this variable after upgrading and configuring an eligible SMS sender.
const trialSmsTemplate = (process.env.TWILIO_TRIAL_TEMPLATE || '').trim();

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
        
        try {
            // Find the user who registered this device.
            const usersRef = await db.ref('/users').once('value');
            let profile = null;

            usersRef.forEach((userSnap) => {
                if (userSnap.child('active_device').val() === deviceMac) {
                    profile = userSnap.child('profile').val();
                }
            });

            if (profile) await sendNotifications(profile);
            else console.warn('[ALARM] No matching user profile; notifications skipped.');
        } catch (err) {
            console.error('[FIREBASE] User lookup failed:', err.message);
            // No notification was attempted, so permit a later update to retry.
            activeAlarms[deviceMac] = false;
        }
        
    } else if (telemetry && telemetry.alarm_triggered === false) {
        activeAlarms[deviceMac] = false; // Reset tracking when stove is safe
    }
}, (err) => console.error('[FIREBASE] Device listener failed:', err.message));

async function sendNotifications(profile) {
    const msg = "⚠️ FORGOTTEN STOVE: Alarm triggered! Go to your kitchen immediately.";
    
    // Send SMS
    if ((profile.alert_preference === 'sms' || profile.alert_preference === 'both') && profile.phone) {
        try {
            const request = trialSmsTemplate
                ? { to: String(profile.phone).trim(), body: trialSmsTemplate }
                : { to: String(profile.phone).trim(), body: msg, from: process.env.TWILIO_PHONE_NUMBER };
            const message = await twilioClient.messages.create(request);
            // Accepted/queued is not a delivery receipt. Check this SID in Twilio Logs.
            console.log('[SMS] Request accepted:', {
                sid: message.sid,
                status: message.status,
                mode: trialSmsTemplate ? 'trial-template' : 'custom-alert'
            });
        } catch (err) {
            console.error('[SMS] Request failed:', {
                code: err.code,
                status: err.status,
                message: err.message,
                moreInfo: err.moreInfo
            });
        }
    }
    
    // Send Email
    if ((profile.alert_preference === 'email' || profile.alert_preference === 'both') && profile.email) {
        try {
            const result = await resend.emails.send({
                from: process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev',
                to: profile.email,
                subject: '⚠️ STOVE ALARM ACTIVATED',
                html: `<h2>Emergency Alert</h2><p>${msg}</p>`
            });
            if (result && result.error) {
                throw new Error(result.error.message || 'Resend returned an error.');
            }
            console.log('[EMAIL] Request accepted:', {
                id: result && (result.id || (result.data && result.data.id))
            });
        } catch (err) { console.error('[EMAIL] Request failed:', err.message); }
    }
}

// HTTP endpoint to keep the server awake
app.get('/ping', (req, res) => res.status(200).send('Awake'));

app.listen(port, () => console.log(`Backend running on port ${port}`));
