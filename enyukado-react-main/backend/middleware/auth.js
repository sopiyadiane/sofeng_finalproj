const jwt = require('jsonwebtoken');
require('dotenv').config();
const { User } = require('../models');

// Verifies "Authorization: Bearer <token>" and sets req.user = { id, isAdmin }.
// Same secret (and fallback) as the login routes in routes/userRoutes.js.
module.exports = async function auth(req, res, next) {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');

    if (scheme !== 'Bearer' || !token) {
        return res.status(401).json({ message: 'No token provided. Access denied.' });
    }

    let decoded;
    try {
        decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret123');
    } catch (err) {
        const message = err.name === 'TokenExpiredError' ? 'Token expired. Please log in again.' : 'Invalid token.';
        return res.status(401).json({ message });
    }

    try {
        const user = await User.findOne({ UserID: decoded.id }, { IsDisabled: 1 }).lean();
        if (!user) {
            return res.status(401).json({ message: 'Account not found. Please log in again.' });
        }
        if (user.IsDisabled) {
            return res.status(403).json({ message: 'This account has been disabled. Contact Enyukado support for assistance.' });
        }
        req.user = { id: decoded.id, isAdmin: !!decoded.isAdmin };
        next();
    } catch (err) {
        console.error('Authentication Account Lookup Error:', err);
        return res.status(500).json({ message: 'Could not verify account access.' });
    }
};
