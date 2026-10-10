const router = require('express').Router();
const auth = require('../middleware/auth');
const { User, Product, Report, nextId } = require('../models');
const { toInt, sendError } = require('../utils/helpers');

const REPORT_REASONS = [
    'Scam or fraud',
    'Prohibited or unsafe item',
    'Misleading information',
    'Inappropriate content',
    'Impersonation',
    'Other'
];

router.post('/', auth, async (req, res) => {
    const targetType = req.body.targetType === 'account' ? 'Account'
        : req.body.targetType === 'listing' ? 'Listing' : null;
    const targetID = toInt(req.body.targetID);
    const selectedReason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    const customReason = typeof req.body.customReason === 'string' ? req.body.customReason.trim() : '';
    const reason = selectedReason === 'Other' ? customReason : selectedReason;
    const details = typeof req.body.details === 'string' ? req.body.details.trim() : '';

    if (!targetType || targetID === null || !REPORT_REASONS.includes(selectedReason)) {
        return res.status(400).json({ message: 'Choose a valid listing or account and a report reason.' });
    }
    if (selectedReason === 'Other' && !customReason) {
        return res.status(400).json({ message: 'Please provide a reason when selecting Other.' });
    }
    if (reason.length > 200) {
        return res.status(400).json({ message: 'Report reason must be 200 characters or fewer.' });
    }
    if (!details) {
        return res.status(400).json({ message: 'Report details are required.' });
    }
    if (details.length > 1000) {
        return res.status(400).json({ message: 'Report details must be 1,000 characters or fewer.' });
    }

    try {
        let targetName;
        if (targetType === 'Listing') {
            const product = await Product.findOne(
                { ProductID: targetID, Status: { $in: ['Available', 'Sold'] } },
                { ProductID: 1, UserID: 1, ProductName: 1 }
            ).lean();
            if (!product) return res.status(404).json({ message: 'This listing is no longer available to report.' });
            if (product.UserID === req.user.id) return res.status(400).json({ message: 'You cannot report your own listing.' });
            targetName = product.ProductName;
        } else {
            const user = await User.findOne(
                { UserID: targetID, IsAdmin: { $ne: true } },
                { UserID: 1, FirstName: 1, LastName: 1 }
            ).lean();
            if (!user) return res.status(404).json({ message: 'This account could not be found.' });
            if (user.UserID === req.user.id) return res.status(400).json({ message: 'You cannot report your own account.' });
            targetName = `${user.FirstName} ${user.LastName}`.trim();
        }

        await Report.create({
            ReportID: await nextId('ReportID'),
            ReporterID: req.user.id,
            TargetType: targetType,
            TargetID: targetID,
            TargetName: targetName,
            Reason: reason,
            Details: details
        });

        if (targetType === 'Account') {
            await Product.updateMany(
                { UserID: targetID, Status: 'Available' },
                { $set: { Status: 'Pending Approval' } }
            );
        }

        res.status(201).json({ message: 'Thank you. Your report has been sent to the Enyukado admin team.' });
    } catch (err) {
        sendError(res, 'Submit Report Error', err);
    }
});

module.exports = router;
