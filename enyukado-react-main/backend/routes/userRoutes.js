const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const auth     = require('../middleware/auth');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const { randomInt } = require('crypto');
const { User, nextId, NO_ID } = require('../models');
const { BASE_URL, toInt, sendError } = require('../utils/helpers');
const { sendVerificationEmail } = require('../utils/emailDelivery');

// ============================================================
// CONSTANTS
// ============================================================
const ALLOWED_DOMAIN = '@students.national-u.edu.ph';

// ============================================================
// MULTER — QR Code uploads
// ============================================================
const qrDir = path.join(__dirname, '..', 'uploads', 'qrcodes');
if (!fs.existsSync(qrDir)) fs.mkdirSync(qrDir, { recursive: true });

const qrStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, qrDir),
    filename:    (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `qr_${req.user.id}_${Date.now()}${ext}`);
    }
});

const qrUpload = multer({
    storage: qrStorage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['.jpg', '.jpeg', '.png', '.webp'];
        if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
        else cb(new Error('Only image files are allowed for QR codes.'));
    }
});

const profilePhotoDir = path.join(__dirname, '..', 'uploads', 'profiles');
if (!fs.existsSync(profilePhotoDir)) fs.mkdirSync(profilePhotoDir, { recursive: true });

const profilePhotoStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, profilePhotoDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `profile_${req.user.id}_${Date.now()}${ext}`);
    }
});

const profilePhotoUpload = multer({
    storage: profilePhotoStorage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['.jpg', '.jpeg', '.png', '.webp'];
        if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
        else cb(new Error('Only image files are allowed for profile photos.'));
    }
});

// ============================================================
// HELPER
// ============================================================
function isValidStudentEmail(email) {
    return typeof email === 'string' && email.toLowerCase().endsWith(ALLOWED_DOMAIN);
}

const RESET_CODES = new Map();
const SIGNUP_CODES = new Map();
const RESET_CODE_TTL_MS = 10 * 60 * 1000;

function getResetCodeEntry(email) {
    const key = String(email || '').trim().toLowerCase();
    const entry = RESET_CODES.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        RESET_CODES.delete(key);
        return null;
    }
    return entry;
}

function setResetCode(email, code) {
    RESET_CODES.set(String(email).trim().toLowerCase(), {
        code,
        expiresAt: Date.now() + RESET_CODE_TTL_MS
    });
}

function clearResetCode(email) {
    RESET_CODES.delete(String(email).trim().toLowerCase());
}

function getSignupCodeEntry(email) {
    const key = String(email || '').trim().toLowerCase();
    const entry = SIGNUP_CODES.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        SIGNUP_CODES.delete(key);
        return null;
    }
    return entry;
}

function setSignupCode(email, code) {
    SIGNUP_CODES.set(String(email).trim().toLowerCase(), {
        code,
        verified: false,
        expiresAt: Date.now() + RESET_CODE_TTL_MS
    });
}

function clearSignupCode(email) {
    SIGNUP_CODES.delete(String(email).trim().toLowerCase());
}

// ============================================================
// ROUTES
// ============================================================

// --- 1. REGISTER ---
router.post('/register', async (req, res) => {
    const { firstName, lastName, email, password } = req.body;
    const cleanEmail = String(email || '').trim().toLowerCase();

    if (!firstName || !lastName || !cleanEmail || !password) {
        return res.status(400).json({ message: 'First name, last name, email, and password are required.' });
    }

    if (!isValidStudentEmail(cleanEmail)) {
        return res.status(400).json({ message: `Only university emails are allowed (${ALLOWED_DOMAIN}).` });
    }

    if (password.length < 6) {
        return res.status(400).json({ message: 'Password must be at least 6 characters.' });
    }

    const signupEntry = getSignupCodeEntry(cleanEmail);
    if (!signupEntry || !signupEntry.verified) {
        return res.status(400).json({ message: 'You must verify your university email before registering.' });
    }

    try {
        const exists = await User.exists({ Email: cleanEmail });
        if (exists) {
            clearSignupCode(cleanEmail);
            return res.status(400).json({ message: 'Email already registered.' });
        }

        const salt           = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        await User.create({
            UserID:      await nextId('UserID'),
            FirstName:   firstName,
            LastName:    lastName,
            Email:       cleanEmail,
            PhoneNumber: null,
            ProfileImage: '/enyukado-default-avatar.svg',
            Password:    hashedPassword,
            WelcomePending: true,
            IsAdmin:     false,
            IsApproved:  false
        });

        clearSignupCode(cleanEmail);
        res.status(201).json({
            message: 'Registration submitted! Your account is pending admin approval.'
        });
    } catch (err) {
        // Unique index on Email — two simultaneous sign-ups with the same address
        if (err.code === 11000) {
            clearSignupCode(cleanEmail);
            return res.status(400).json({ message: 'Email already registered.' });
        }
        sendError(res, 'Register Error', err);
    }
});

// --- 2. STUDENT LOGIN ---
router.post('/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ message: 'Email and password are required.' });
    }

    if (!isValidStudentEmail(email)) {
        return res.status(400).json({ message: `Only university emails are allowed (${ALLOWED_DOMAIN}).` });
    }

    try {
        const user = await User.findOne({ Email: email.toLowerCase().trim() }).lean();
        if (!user) return res.status(404).json({ message: 'User not found.' });

        if (user.IsAdmin) {
            return res.status(403).json({ message: 'Please use the admin portal to log in.' });
        }

        if (user.IsRejected) {
            return res.status(403).json({ message: 'Your account registration was rejected. Please contact the Enyukado team for assistance.' });
        }
        if (user.IsDisabled) {
            return res.status(403).json({
                message: 'Your account has been disabled. Please contact the admin by email at contact.enyukado@gmail.com to request reactivation.'
            });
        }

        if (!user.IsApproved) {
            return res.status(403).json({ message: 'Your account is pending admin approval. Please wait.' });
        }

        const isMatch = await bcrypt.compare(password, user.Password);
        if (!isMatch) return res.status(400).json({ message: 'Invalid credentials.' });

        const welcomeUpdate = await User.updateOne(
            { _id: user._id, WelcomePending: true },
            { $set: { WelcomePending: false } }
        );
        const isFirstLogin = welcomeUpdate.modifiedCount === 1;

        const token = jwt.sign(
            { id: user.UserID, isAdmin: false },
            process.env.JWT_SECRET || 'secret123',
            { expiresIn: '1d' }
        );

        res.json({
            token,
            user: {
                id:          user.UserID,
                firstName:   user.FirstName,
                lastName:    user.LastName,
                email:       user.Email,
                profileImage: user.ProfileImage,
                qrCodeImage: user.QRCodeImage,
                isFirstLogin,
                isAdmin:     false
            }
        });
    } catch (err) {
        sendError(res, 'Login Error', err);
    }
});

// --- 3. ADMIN LOGIN ---
router.post('/admin-login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ message: 'Email and password are required.' });
    }

    try {
        const user = await User.findOne({ Email: email.toLowerCase().trim() }).lean();
        if (!user) return res.status(404).json({ message: 'User not found.' });

        if (!user.IsAdmin) {
            return res.status(403).json({ message: 'Unauthorized access.' });
        }

        const isMatch = await bcrypt.compare(password, user.Password);
        if (!isMatch) return res.status(400).json({ message: 'Invalid credentials.' });

        const token = jwt.sign(
            { id: user.UserID, isAdmin: true },
            process.env.JWT_SECRET || 'secret123',
            { expiresIn: '1d' }
        );

        res.json({
            token,
            user: {
                id:        user.UserID,
                firstName: user.FirstName,
                lastName:  user.LastName,
                email:     user.Email,
                isAdmin:   true
            }
        });
    } catch (err) {
        sendError(res, 'Admin Login Error', err);
    }
});

// --- 4. SEND SIGNUP VERIFICATION CODE ---
router.post('/send-signup-code', async (req, res) => {
    const email = String(req.body.email ?? '').trim().toLowerCase();
    if (!isValidStudentEmail(email)) {
        return res.status(400).json({ message: `Only university emails are allowed (${ALLOWED_DOMAIN}).` });
    }

    try {
        const userExists = await User.exists({ Email: email });
        if (userExists) {
            return res.status(400).json({ message: 'An account with that email already exists.' });
        }

        const code = String(randomInt(100000, 1000000));
        try {
            await sendVerificationEmail(email, code, 'signup');
        } catch (emailError) {
            if (emailError.code === 'EMAIL_NOT_CONFIGURED') {
                return res.status(503).json({ message: 'Email delivery is not configured. Set EMAIL_PROVIDER, RESEND_API_KEY, and EMAIL_FROM in backend/.env using backend/.env.example as a guide.' });
            }
            console.error('[Signup email] Delivery failed:', emailError.message);
            return res.status(502).json({ message: 'Could not send the verification code. Check the sender settings, then try again. If the problem continues, contact contact.enyukado@gmail.com.' });
        }

        setSignupCode(email, code);
        res.json({
            message: 'The email service accepted the verification code for delivery. Check your inbox and Spam/Junk folder; delivery to the mailbox is not confirmed.',
            identifier: email
        });
    } catch (err) {
        sendError(res, 'Send Signup Confirmation Error', err);
    }
});

// --- 5. VERIFY SIGNUP CODE ---
router.post('/verify-signup-code', async (req, res) => {
    const email = String(req.body.email ?? '').trim().toLowerCase();
    const { code } = req.body;
    if (!isValidStudentEmail(email) || !code) {
        return res.status(400).json({ message: 'A valid university email and verification code are required.' });
    }

    const entry = getSignupCodeEntry(email);
    if (!entry) return res.status(400).json({ message: 'No valid signup code was found. Request a new code.' });
    if (String(code).trim() !== entry.code) {
        return res.status(400).json({ message: 'The verification code is incorrect.' });
    }

    entry.verified = true;
    SIGNUP_CODES.set(email, entry);
    res.json({ message: 'Verification code confirmed.' });
});

// --- 6. GET MY PROFILE ---
router.get('/profile', auth, async (req, res) => {
    try {
        const user = await User.findOne(
            { UserID: req.user.id },
            { ...NO_ID, UserID: 1, FirstName: 1, LastName: 1, Email: 1,
                            QRCodeImage: 1, ProfileImage: 1, IsAdmin: 1, IsApproved: 1,
              Bio: 1, Course: 1, Year: 1, CampusArea: 1, PhoneNumber: 1, MessengerLink: 1,
              DateCreated: 1, PasswordChangedAt: 1 }
        ).lean();

        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        res.json(user);
    } catch (err) {
        sendError(res, 'Profile Error', err);
    }
});

// --- 5. UPDATE MY PROFILE ---
router.put('/profile', auth, async (req, res) => {
    const { firstName, lastName, bio, course, year, campusArea, phoneNumber, messengerLink } = req.body;

    if (!firstName || !lastName) {
        return res.status(400).json({ message: 'First name and last name are required.' });
    }
    const normalizedPhone = typeof phoneNumber === 'string' ? phoneNumber.trim() : '';
    const normalizedMessenger = typeof messengerLink === 'string' ? messengerLink.trim() : '';
    if (!normalizedPhone || !normalizedMessenger) {
        return res.status(400).json({ message: 'Contact number and Messenger link are required.' });
    }
    if (normalizedPhone.length > 40) {
        return res.status(400).json({ message: 'Contact number must be 40 characters or fewer.' });
    }
    if (normalizedMessenger) {
        try {
            const url = new URL(normalizedMessenger);
            if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid protocol');
        } catch {
            return res.status(400).json({ message: 'Messenger link must be a valid http or https URL.' });
        }
    }
    try {
        await User.updateOne(
            { UserID: req.user.id },
            { $set: {
                FirstName:  firstName,
                LastName:   lastName,
                Bio:        bio        || null,
                Course:     course     || null,
                Year:       year       || null,
                CampusArea: campusArea || null,
                PhoneNumber: normalizedPhone || null,
                MessengerLink: normalizedMessenger || null
            } },
            { runValidators: true }
        );

        res.json({ message: 'Profile updated successfully!' });
    } catch (err) {
        sendError(res, 'Update Profile Error', err);
    }
});

// --- 6. UPLOAD / UPDATE QR CODE ---
router.post('/qr', auth, qrUpload.single('qrCode'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ message: 'No QR code image uploaded.' });
    }

    const newQRUrl = `${BASE_URL}/uploads/qrcodes/${req.file.filename}`;

    try {
        const old   = await User.findOne({ UserID: req.user.id }, { QRCodeImage: 1 }).lean();
        const oldQR = old?.QRCodeImage;
        if (oldQR && oldQR.includes('/uploads/qrcodes/')) {
            const oldFilename = oldQR.split('/uploads/qrcodes/')[1];
            const oldPath     = path.join(qrDir, oldFilename);
            if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        }

        await User.updateOne({ UserID: req.user.id }, { $set: { QRCodeImage: newQRUrl } });

        res.json({ message: 'QR code updated!', qrCodeImage: newQRUrl });
    } catch (err) {
        sendError(res, 'QR Upload Error', err);
    }
});

// --- 7. UPLOAD / UPDATE PROFILE PHOTO ---
router.post('/photo', auth, profilePhotoUpload.single('profilePhoto'), async (req, res) => {
    if (!req.file) return res.status(400).json({ message: 'No profile photo uploaded.' });

    const newPhotoUrl = `${BASE_URL}/uploads/profiles/${req.file.filename}`;
    try {
        const old = await User.findOne({ UserID: req.user.id }, { ProfileImage: 1 }).lean();
        await User.updateOne({ UserID: req.user.id }, { $set: { ProfileImage: newPhotoUrl } });
        const oldPhoto = old?.ProfileImage;
        if (oldPhoto && oldPhoto.includes('/uploads/profiles/')) {
            const oldFilename = path.basename(oldPhoto.split('/uploads/profiles/')[1]);
            const oldPath = path.join(profilePhotoDir, oldFilename);
            if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        }
        res.json({ message: 'Profile photo updated!', profileImage: newPhotoUrl });
    } catch (err) {
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        sendError(res, 'Profile Photo Upload Error', err);
    }
});

// --- 8. CHANGE PASSWORD ---
router.put('/change-password', auth, async (req, res) => {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
        return res.status(400).json({ message: 'Current and new password are required.' });
    }

    if (newPassword.length < 6) {
        return res.status(400).json({ message: 'New password must be at least 6 characters.' });
    }

    try {
        const user = await User.findOne({ UserID: req.user.id }, { Password: 1 }).lean();
        if (!user) return res.status(404).json({ message: 'User not found.' });

        const isMatch = await bcrypt.compare(currentPassword, user.Password);
        if (!isMatch) return res.status(400).json({ message: 'Current password is incorrect.' });

        const salt           = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);

        await User.updateOne(
            { UserID: req.user.id },
            { $set: { Password: hashedPassword, PasswordChangedAt: new Date() } }
        );

        res.json({ message: 'Password changed successfully!' });
    } catch (err) {
        sendError(res, 'Change Password Error', err);
    }
});

// --- 9. REQUEST PASSWORD RESET CODE ---
router.post('/forgot-password', async (req, res) => {
    const email = String(req.body.identifier ?? req.body.email ?? '').trim().toLowerCase();
    if (!isValidStudentEmail(email)) {
        return res.status(400).json({ message: `Only university emails are allowed (${ALLOWED_DOMAIN}).` });
    }

    try {
        const user = await User.findOne({ Email: email }).lean();
        if (!user) return res.status(404).json({ message: 'No account is registered with that email.' });

        const code = String(randomInt(100000, 1000000));
        try {
            await sendVerificationEmail(user.Email, code, 'password-reset');
        } catch (emailError) {
            if (emailError.code === 'EMAIL_NOT_CONFIGURED') {
                return res.status(503).json({ message: 'Email delivery is not configured. Set EMAIL_PROVIDER, RESEND_API_KEY, and EMAIL_FROM in backend/.env using backend/.env.example as a guide.' });
            }
            console.error('[Password reset email] Delivery failed:', emailError.message);
            return res.status(502).json({ message: 'Could not send the verification code. Check the sender settings, then try again. If the problem continues, contact contact.enyukado@gmail.com.' });
        }

        setResetCode(user.Email, code);
        res.json({
            message: 'The email service accepted the verification code for delivery. Check your inbox and Spam/Junk folder; delivery to the mailbox is not confirmed.',
            identifier: user.Email
        });
    } catch (err) {
        sendError(res, 'Forgot Password Error', err);
    }
});

// --- 10. VERIFY PASSWORD RESET CODE ---
router.post('/verify-reset-code', async (req, res) => {
    const email = String(req.body.identifier ?? req.body.email ?? '').trim().toLowerCase();
    const { code } = req.body;
    if (!isValidStudentEmail(email) || !code) {
        return res.status(400).json({ message: 'A valid university email and verification code are required.' });
    }

    const entry = getResetCodeEntry(email);
    if (!entry) return res.status(400).json({ message: 'No valid reset code was found. Request a new code.' });
    if (String(code).trim() !== entry.code) {
        return res.status(400).json({ message: 'The verification code is incorrect.' });
    }

    res.json({ message: 'Verification code confirmed.' });
});

// --- 11. RESET PASSWORD WITH VERIFIED CODE ---
router.put('/reset-password', async (req, res) => {
    const email = String(req.body.identifier ?? req.body.email ?? '').trim().toLowerCase();
    const { code, newPassword } = req.body;
    if (!isValidStudentEmail(email) || !code || !newPassword) {
        return res.status(400).json({ message: 'A valid university email, verification code, and new password are required.' });
    }

    const entry = getResetCodeEntry(email);
    if (!entry) return res.status(400).json({ message: 'Your reset session expired. Request a new code.' });
    if (String(code).trim() !== entry.code) {
        return res.status(400).json({ message: 'The verification code is incorrect.' });
    }

    const strongPassword = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>/?]).{8,}$/;
    if (!strongPassword.test(newPassword)) {
        return res.status(400).json({
            message: 'Password must be at least 8 characters and include uppercase, lowercase, a number, and a special character.'
        });
    }

    try {
        const user = await User.findOne({ Email: email }).lean();
        if (!user) return res.status(404).json({ message: 'Account not found.' });

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);
        await User.updateOne(
            { _id: user._id },
            { $set: { Password: hashedPassword, PasswordChangedAt: new Date() } }
        );

        clearResetCode(email);
        res.json({ message: 'Password reset successfully.' });
    } catch (err) {
        sendError(res, 'Reset Password Error', err);
    }
});

// --- 12. GET ANY USER'S PUBLIC PROFILE ---
router.get('/:id', async (req, res) => {
    try {
        const id = toInt(req.params.id);
        if (id === null) return res.status(404).json({ message: 'User not found.' });

        const user = await User.findOne(
            { UserID: id, IsDisabled: { $ne: true } },
            { ...NO_ID, UserID: 1, FirstName: 1, LastName: 1,
              ProfileImage: 1, QRCodeImage: 1, Bio: 1, Course: 1, Year: 1, CampusArea: 1,
              PhoneNumber: 1, MessengerLink: 1, DateCreated: 1 }
        ).lean();

        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        res.json(user);
    } catch (err) {
        sendError(res, 'Get User Error', err);
    }
});

module.exports = router;
