const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const auth    = require('../middleware/auth');
const { User, Product, Category, Transaction, SavedItem, Report, nextId, NO_ID } = require('../models');
const { sendBotMessage } = require('../services/messaging');
const { toInt, indexBy, sendError } = require('../utils/helpers');

// ============================================================
// CONSTANTS
// ============================================================
const PICKUP_LOCATION = 'Student Affairs Office, Ground Floor, Building A';

// ============================================================
// MIDDLEWARE — admin guard
// Blocks any non-admin user from all admin routes
// ============================================================
function adminOnly(req, res, next) {
    if (!req.user || !req.user.isAdmin) {
        return res.status(403).json({ message: 'Unauthorized: Admin access required.' });
    }
    next();
}

// System notifications are sent FROM the Enyukado Bot account
const sendSystemMessage = sendBotMessage;
const productUploadsDir = path.join(__dirname, '..', 'uploads', 'products');

function deleteProductImageFiles(images, primaryImageURL) {
    const imageURLs = [...(images || []).map(image => image.ImageURL), primaryImageURL];
    for (const imageURL of new Set(imageURLs)) {
        if (!imageURL || !imageURL.includes('/uploads/products/')) continue;
        const filename = path.basename(imageURL.split('/uploads/products/')[1]);
        const filePath = path.join(productUploadsDir, filename);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
}

// ============================================================
// ROUTES — all require auth + adminOnly
// ============================================================

// -------------------------------------------------------
// SECTION A: ACCOUNT APPROVALS
// -------------------------------------------------------

// --- A1. GET ALL PENDING ACCOUNTS ---
// GET /api/admin/accounts/pending
router.get('/accounts/pending', auth, adminOnly, async (req, res) => {
    try {
        const users = await User.find(
            { IsApproved: false, IsRejected: { $ne: true }, IsAdmin: { $ne: true } },
            { ...NO_ID, UserID: 1, FirstName: 1, LastName: 1, Email: 1, DateCreated: 1, IsRejected: 1 }
        ).sort({ DateCreated: 1 }).lean();

        res.json(users);
    } catch (err) {
        sendError(res, 'Get Pending Accounts Error', err);
    }
});

// --- A1b. GET ALL STUDENT ACCOUNTS ---
// GET /api/admin/accounts/all
router.get('/accounts/all', auth, adminOnly, async (req, res) => {
    try {
        const users = await User.find(
            { IsAdmin: { $ne: true } },
            { ...NO_ID, UserID: 1, FirstName: 1, LastName: 1, Email: 1, IsApproved: 1, IsRejected: 1, IsDisabled: 1, RejectionReason: 1, DateCreated: 1 }
        ).sort({ DateCreated: -1 }).lean();

        res.json(users);
    } catch (err) {
        sendError(res, 'Get All Accounts Error', err);
    }
});

// --- A1c. GET STUDENT ACCOUNT DETAILS ---
// GET /api/admin/accounts/:id/details
router.get('/accounts/:id/details', auth, adminOnly, async (req, res) => {
    const userID = toInt(req.params.id);
    if (userID === null) return res.status(400).json({ message: 'Invalid account ID.' });

    try {
        const account = await User.findOne(
            { UserID: userID, IsAdmin: { $ne: true } },
            { ...NO_ID, UserID: 1, FirstName: 1, LastName: 1, Email: 1,
              IsApproved: 1, IsRejected: 1, IsDisabled: 1, RejectionReason: 1, DateCreated: 1, ProfileImage: 1, Bio: 1, Course: 1, Year: 1, CampusArea: 1 }
        ).lean();
        if (!account) return res.status(404).json({ message: 'Student account not found.' });

        const [listings, transactions] = await Promise.all([
            Product.find(
                { UserID: userID },
                { ...NO_ID, ProductID: 1, ProductName: 1, Price: 1, ProductCondition: 1,
                  Quantity: 1, Status: 1, DatePosted: 1, ImageURL: 1, CategoryID: 1 }
            ).sort({ DatePosted: -1 }).lean(),
            Transaction.find(
                { BuyerID: userID },
                { ...NO_ID, TransactionID: 1, ProductID: 1, SellerID: 1, Status: 1, ShippingStatus: 1, TransactionDate: 1 }
            ).sort({ TransactionDate: -1 }).lean()
        ]);

        const [purchasedProducts, categories, sellers] = await Promise.all([
            Product.find(
                { ProductID: { $in: transactions.map((transaction) => transaction.ProductID) } },
                { ...NO_ID, ProductID: 1, ProductName: 1, Price: 1, ImageURL: 1, CategoryID: 1 }
            ).lean(),
            Category.find(
                { CategoryID: { $in: [...listings, ...transactions].map((item) => item.CategoryID).filter(Boolean) } },
                { ...NO_ID, CategoryID: 1, CategoryName: 1 }
            ).lean(),
            User.find(
                { UserID: { $in: transactions.map((transaction) => transaction.SellerID) } },
                { ...NO_ID, UserID: 1, FirstName: 1, LastName: 1 }
            ).lean()
        ]);

        const productMap = indexBy(purchasedProducts, 'ProductID');
        const categoryMap = indexBy(categories, 'CategoryID');
        const sellerMap = indexBy(sellers, 'UserID');

        res.json({
            account,
            listings: listings.map((product) => ({
                ...product,
                CategoryName: categoryMap.get(product.CategoryID)?.CategoryName ?? null
            })),
            purchases: transactions.map((transaction) => {
                const product = productMap.get(transaction.ProductID);
                const seller = sellerMap.get(transaction.SellerID);
                return {
                    TransactionID: transaction.TransactionID,
                    Status: transaction.Status,
                    ShippingStatus: transaction.ShippingStatus || 'Not Started',
                    TransactionDate: transaction.TransactionDate,
                    ProductID: transaction.ProductID,
                    ProductName: product?.ProductName ?? 'Listing no longer available',
                    Price: product?.Price ?? null,
                    ImageURL: product?.ImageURL ?? null,
                    CategoryName: product ? categoryMap.get(product.CategoryID)?.CategoryName ?? null : null,
                    SellerName: seller ? `${seller.FirstName} ${seller.LastName}` : 'Unknown seller'
                };
            })
        });
    } catch (err) {
        sendError(res, 'Get Account Details Error', err);
    }
});

// --- A2. APPROVE AN ACCOUNT ---
// PATCH /api/admin/accounts/:id/approve
router.patch('/accounts/:id/approve', auth, adminOnly, async (req, res) => {
    const userID = toInt(req.params.id);

    try {
        const user = userID === null ? null
            : await User.findOne({ UserID: userID }, { UserID: 1, FirstName: 1, IsApproved: 1 }).lean();

        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }
        if (user.IsApproved) {
            return res.status(400).json({ message: 'Account is already approved.' });
        }

        await User.updateOne(
            { UserID: userID },
            { $set: { IsApproved: true, IsRejected: false, RejectionReason: null } }
        );

        res.json({ message: `Account for ${user.FirstName} approved successfully.` });
    } catch (err) {
        sendError(res, 'Approve Account Error', err);
    }
});

// --- A2b. RE-ENABLE A DISABLED ACCOUNT ---
// PATCH /api/admin/accounts/:id/enable
router.patch('/accounts/:id/enable', auth, adminOnly, async (req, res) => {
    const userID = toInt(req.params.id);

    try {
        const user = userID === null ? null
            : await User.findOne(
                { UserID: userID, IsAdmin: { $ne: true } },
                { UserID: 1, FirstName: 1, IsDisabled: 1, IsApproved: 1 }
            ).lean();

        if (!user) return res.status(404).json({ message: 'Student account not found.' });
        if (!user.IsDisabled) return res.status(400).json({ message: 'Account is not disabled.' });

        await User.updateOne(
            { UserID: userID, IsDisabled: true },
            { $set: { IsDisabled: false } }
        );

        const listingMessage = user.IsApproved
            ? ' Any listings awaiting approval still need to be approved separately.'
            : ' The account still needs initial approval before the user can log in.';
        res.json({ message: `Account for ${user.FirstName} has been re-enabled.${listingMessage}` });
    } catch (err) {
        sendError(res, 'Enable Account Error', err);
    }
});

// --- A3. REJECT AN ACCOUNT ---
// PATCH /api/admin/accounts/:id/reject
// Body: { reason (optional) }
// Keep the rejected account so admins can review it later.
router.patch('/accounts/:id/reject', auth, adminOnly, async (req, res) => {
    const userID = toInt(req.params.id);
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';

    try {
        const user = userID === null ? null
            : await User.findOne({ UserID: userID }, { UserID: 1, FirstName: 1, IsApproved: 1, IsRejected: 1 }).lean();

        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }
        if (user.IsApproved) {
            return res.status(400).json({ message: 'Cannot reject an already approved account.' });
        }
        if (user.IsRejected) {
            return res.status(400).json({ message: 'Account is already rejected.' });
        }

        await User.updateOne(
            { UserID: userID },
            { $set: { IsApproved: false, IsRejected: true, RejectionReason: reason || null } }
        );

        res.json({ message: `Account for ${user.FirstName} was rejected.` });
    } catch (err) {
        sendError(res, 'Reject Account Error', err);
    }
});

// --- A4. DELETE A REJECTED ACCOUNT ---
// DELETE /api/admin/accounts/:id
router.delete('/accounts/:id', auth, adminOnly, async (req, res) => {
    const userID = toInt(req.params.id);

    try {
        const user = userID === null ? null
            : await User.findOne(
                { UserID: userID, IsRejected: true, IsAdmin: { $ne: true } },
                { UserID: 1, FirstName: 1 }
            ).lean();

        if (!user) {
            return res.status(404).json({ message: 'Rejected account not found.' });
        }

        const listings = await Product.find(
            { UserID: userID },
            { ...NO_ID, ProductID: 1, ImageURL: 1, images: 1 }
        ).lean();
        const listingIDs = listings.map((listing) => listing.ProductID);

        await Product.deleteMany({ UserID: userID });
        await SavedItem.deleteMany({ $or: [{ UserID: userID }, { ProductID: { $in: listingIDs } }] });
        await User.deleteOne({ UserID: userID, IsRejected: true, IsAdmin: { $ne: true } });

        listings.forEach((listing) => deleteProductImageFiles(listing.images, listing.ImageURL));
        res.json({ message: `Rejected account for ${user.FirstName} and ${listings.length} listing(s) were deleted.` });
    } catch (err) {
        sendError(res, 'Delete Rejected Account Error', err);
    }
});

// -------------------------------------------------------
// SECTION B: LISTING APPROVALS
// -------------------------------------------------------

// --- B0. GET ALL LISTINGS ---
// GET /api/admin/listings/all
router.get('/listings/all', auth, adminOnly, async (req, res) => {
    try {
        const sellerIDs = await User.distinct('UserID', { IsAdmin: { $ne: true }, IsDisabled: { $ne: true } });
        const products = await Product.find({ UserID: { $in: sellerIDs }, Status: { $in: ['Available', 'Sold'] } }, NO_ID)
            .sort({ DatePosted: -1 })
            .lean();
        const [categories, sellers] = await Promise.all([
            Category.find({ CategoryID: { $in: products.map(p => p.CategoryID) } }, NO_ID).lean(),
            User.find({ UserID: { $in: products.map(p => p.UserID) } },
                { ...NO_ID, UserID: 1, FirstName: 1, LastName: 1, Email: 1, IsApproved: 1, IsRejected: 1 }).lean()
        ]);
        const categoryMap = indexBy(categories, 'CategoryID');
        const sellerMap = indexBy(sellers, 'UserID');

        res.json(products.map(p => {
            const seller = sellerMap.get(p.UserID);
            return {
                ProductID: p.ProductID,
                ProductName: p.ProductName,
                Price: p.Price,
                ProductCondition: p.ProductCondition,
                Description: p.Description,
                Quantity: p.Quantity,
                ImageURL: p.ImageURL,
                DatePosted: p.DatePosted,
                Status: p.Status,
                CategoryName: categoryMap.get(p.CategoryID)?.CategoryName ?? null,
                SellerID: seller?.UserID ?? p.UserID,
                SellerFirstName: seller?.FirstName ?? 'Unknown',
                SellerLastName: seller?.LastName ?? '',
                SellerEmail: seller?.Email ?? '',
                SellerIsApproved: seller?.IsApproved ?? null,
                SellerIsRejected: seller?.IsRejected ?? false,
                images: (p.images || []).slice().sort((a, b) => a.SortOrder - b.SortOrder)
            };
        }));
    } catch (err) {
        sendError(res, 'Get All Listings Error', err);
    }
});

// --- B1. GET ALL PENDING LISTINGS ---
// GET /api/admin/listings/pending
router.get('/listings/pending', auth, adminOnly, async (req, res) => {
    try {
        const sellerIDs = await User.distinct('UserID', { IsAdmin: { $ne: true }, IsDisabled: { $ne: true } });
        const products = await Product.find({ UserID: { $in: sellerIDs }, Status: 'Pending Approval' }, NO_ID)
            .sort({ DatePosted: 1 })
            .lean();

        const [categories, sellers] = await Promise.all([
            Category.find({ CategoryID: { $in: products.map(p => p.CategoryID) } }, NO_ID).lean(),
            User.find({ UserID: { $in: products.map(p => p.UserID) } },
                { ...NO_ID, UserID: 1, FirstName: 1, LastName: 1, Email: 1, IsApproved: 1, IsRejected: 1 }).lean()
        ]);
        const categoryMap = indexBy(categories, 'CategoryID');
        const sellerMap   = indexBy(sellers, 'UserID');

        const rows = products.map(p => {
            const c = categoryMap.get(p.CategoryID);
            const u = sellerMap.get(p.UserID);
            return {
                ProductID:        p.ProductID,
                ProductName:      p.ProductName,
                Price:            p.Price,
                ProductCondition: p.ProductCondition,
                Description:      p.Description,
                Quantity:         p.Quantity,
                ImageURL:         p.ImageURL,
                DatePosted:       p.DatePosted,
                CategoryName:     c?.CategoryName ?? 'Uncategorized',
                SellerID:         u?.UserID ?? p.UserID,
                SellerFirstName:  u?.FirstName ?? 'Unknown',
                SellerLastName:   u?.LastName ?? '',
                SellerEmail:      u?.Email ?? '',
                SellerIsApproved: u?.IsApproved ?? null,
                SellerIsRejected: u?.IsRejected ?? false,
                images:           (p.images || []).slice().sort((a, b) => a.SortOrder - b.SortOrder)
            };
        });

        res.json(rows);
    } catch (err) {
        sendError(res, 'Get Pending Listings Error', err);
    }
});

// --- B2. APPROVE A LISTING ---
// PATCH /api/admin/listings/:id/approve
router.patch('/listings/:id/approve', auth, adminOnly, async (req, res) => {
    const productID = toInt(req.params.id);

    try {
        const product = productID === null ? null
            : await Product.findOne({ ProductID: productID }, { ProductID: 1, ProductName: 1, Status: 1, UserID: 1 }).lean();

        if (!product) {
            return res.status(404).json({ message: 'Product not found.' });
        }
        if (product.Status !== 'Pending Approval') {
            return res.status(400).json({ message: 'Listing is not pending approval.' });
        }

        await Product.updateOne({ ProductID: productID }, { $set: { Status: 'Available' } });

        // System message → seller
        await sendSystemMessage(
            product.UserID,
            null,
            `Your listing "${product.ProductName}" has been approved and is now live on the marketplace!`
        );

        res.json({ message: 'Listing approved and now live.' });
    } catch (err) {
        sendError(res, 'Approve Listing Error', err);
    }
});

// --- B3. REJECT A LISTING ---
// PATCH /api/admin/listings/:id/reject
// Body: { reason }
router.patch('/listings/:id/reject', auth, adminOnly, async (req, res) => {
    const productID = toInt(req.params.id);
    const { reason } = req.body;

    if (!reason || reason.trim() === '') {
        return res.status(400).json({ message: 'A reason is required when rejecting a listing.' });
    }

    try {
        const product = productID === null ? null
            : await Product.findOne({ ProductID: productID }, { ProductID: 1, ProductName: 1, Status: 1, UserID: 1 }).lean();

        if (!product) {
            return res.status(404).json({ message: 'Product not found.' });
        }
        if (product.Status !== 'Pending Approval') {
            return res.status(400).json({ message: 'Listing is not pending approval.' });
        }

        // Delete the listing entirely on rejection (embedded images go with it)
        await Product.deleteOne({ ProductID: productID });
        await SavedItem.deleteMany({ ProductID: productID });

        // System message → seller with reason
        await sendSystemMessage(
            product.UserID,
            null,
            `Your listing "${product.ProductName}" was rejected. Reason: ${reason.trim()}`
        );

        res.json({ message: 'Listing rejected and removed. Seller has been notified.' });
    } catch (err) {
        sendError(res, 'Reject Listing Error', err);
    }
});

// --- B4. DELETE ANY LISTING ---
// DELETE /api/admin/listings/:id
router.delete('/listings/:id', auth, adminOnly, async (req, res) => {
    const productID = toInt(req.params.id);
    try {
        const product = productID === null ? null
            : await Product.findOne({ ProductID: productID }, { ProductID: 1, ProductName: 1, ImageURL: 1, images: 1 }).lean();
        if (!product) return res.status(404).json({ message: 'Product not found.' });

        const hasTransactions = await Transaction.exists({ ProductID: productID });
        if (hasTransactions) {
            return res.status(400).json({ message: 'This listing has purchase records and cannot be deleted.' });
        }

        deleteProductImageFiles(product.images, product.ImageURL);
        await Product.deleteOne({ ProductID: productID });
        await SavedItem.deleteMany({ ProductID: productID });
        res.json({ message: 'Listing deleted successfully.' });
    } catch (err) {
        sendError(res, 'Admin Delete Listing Error', err);
    }
});

// -------------------------------------------------------
// SECTION C: PAYMENT APPROVALS
// -------------------------------------------------------

// --- C1. GET ALL PENDING PAYMENTS ---
// GET /api/admin/payments/pending
router.get('/payments/pending', auth, adminOnly, async (req, res) => {
    try {
        const transactions = await Transaction.find({ Status: 'Pending' }, NO_ID)
            .sort({ TransactionDate: 1 })
            .lean();

        const [products, users] = await Promise.all([
            Product.find({ ProductID: { $in: transactions.map(t => t.ProductID) } }, NO_ID).lean(),
            User.find({ UserID: { $in: transactions.flatMap(t => [t.BuyerID, t.SellerID]) } },
                { ...NO_ID, UserID: 1, FirstName: 1, LastName: 1, Email: 1, IsRejected: 1 }).lean()
        ]);
        const productMap = indexBy(products, 'ProductID');
        const userMap    = indexBy(users, 'UserID');

        const rows = [];
        for (const t of transactions) {
            const p      = productMap.get(t.ProductID);
            const buyer  = userMap.get(t.BuyerID);
            const seller = userMap.get(t.SellerID);
            if (!p || !buyer || !seller) continue;
            rows.push({
                TransactionID:     t.TransactionID,
                Status:            t.Status,
                TransactionDate:   t.TransactionDate,
                PaymentMethod:     t.PaymentMethod,
                PaymentProofImage: t.PaymentProofImage,
                ProductID:         p.ProductID,
                ProductName:       p.ProductName,
                Price:             p.Price,
                ImageURL:          p.ImageURL,
                BuyerID:           buyer.UserID,
                BuyerFirstName:    buyer.FirstName,
                BuyerLastName:     buyer.LastName,
                BuyerEmail:        buyer.Email,
                SellerID:          seller.UserID,
                SellerFirstName:   seller.FirstName,
                SellerLastName:    seller.LastName,
                SellerIsRejected:  seller.IsRejected ?? false
            });
        }

        res.json(rows);
    } catch (err) {
        sendError(res, 'Get Pending Payments Error', err);
    }
});

// --- C2. APPROVE A PAYMENT ---
// PATCH /api/admin/payments/:id/approve
// Flips transaction to 'Payment Approved'
// Flips product to 'Sold'
// Notifies both buyer and seller via system messages
router.patch('/payments/:id/approve', auth, adminOnly, async (req, res) => {
    const transactionID = toInt(req.params.id);

    try {
        const tx = transactionID === null ? null
            : await Transaction.findOne({ TransactionID: transactionID }).lean();
        const product = tx && await Product.findOne({ ProductID: tx.ProductID }, { ProductName: 1 }).lean();

        if (!tx || !product) {
            return res.status(404).json({ message: 'Transaction not found.' });
        }
        if (tx.Status !== 'Pending') {
            return res.status(400).json({ message: 'Transaction is not pending payment approval.' });
        }

        // Flip transaction status (only if still Pending, so a double-click can't approve twice)
        const updated = await Transaction.updateOne(
            { TransactionID: transactionID, Status: 'Pending' },
            { $set: { Status: 'Payment Approved', ShippingStatus: 'For Drop Off' } }
        );
        if (updated.modifiedCount === 0) {
            return res.status(400).json({ message: 'Transaction is not pending payment approval.' });
        }

        // Flip product to Sold
        await Product.updateOne({ ProductID: tx.ProductID }, { $set: { Status: 'Sold' } });

        // System notification → seller
        await sendSystemMessage(
            tx.SellerID, transactionID,
            `✅ Payment for "${product.ProductName}" has been confirmed by admin! Please drop it off at ${PICKUP_LOCATION} as soon as possible.`
        );

        // System notification → buyer
        await sendSystemMessage(
            tx.BuyerID, transactionID,
            `✅ Your payment for "${product.ProductName}" has been confirmed! The seller has been notified to drop it off at ${PICKUP_LOCATION}.`
        );

        res.json({ message: 'Payment approved. Both parties have been notified.' });
    } catch (err) {
        sendError(res, 'Approve Payment Error', err);
    }
});

// --- C3. REJECT A PAYMENT ---
// PATCH /api/admin/payments/:id/reject
// Body: { reason }
// Cancels the transaction, puts product back to Available
// Notifies buyer via system message
router.patch('/payments/:id/reject', auth, adminOnly, async (req, res) => {
    const transactionID = toInt(req.params.id);
    const { reason }    = req.body;

    if (!reason || reason.trim() === '') {
        return res.status(400).json({ message: 'A reason is required when rejecting a payment.' });
    }

    try {
        const tx = transactionID === null ? null
            : await Transaction.findOne({ TransactionID: transactionID }).lean();
        const product = tx && await Product.findOne({ ProductID: tx.ProductID }, { ProductName: 1 }).lean();

        if (!tx || !product) {
            return res.status(404).json({ message: 'Transaction not found.' });
        }
        if (tx.Status !== 'Pending') {
            return res.status(400).json({ message: 'Transaction is not pending payment approval.' });
        }

        // Cancel the transaction (only if still Pending)
        const updated = await Transaction.updateOne(
            { TransactionID: transactionID, Status: 'Pending' },
            { $set: { Status: 'Cancelled' } }
        );
        if (updated.modifiedCount === 0) {
            return res.status(400).json({ message: 'Transaction is not pending payment approval.' });
        }

        // Put product back to Available
        await Product.updateOne({ ProductID: tx.ProductID }, { $set: { Status: 'Available' } });

        // System message → buyer with reason
        await sendSystemMessage(
            tx.BuyerID, transactionID,
            `Your payment proof for "${product.ProductName}" was rejected. Reason: ${reason.trim()}. Please resubmit or contact contact.enyukado@gmail.com.`
        );

        // System message → seller
        await sendSystemMessage(
            tx.SellerID, transactionID,
            `The payment for "${product.ProductName}" was rejected by admin. The listing has been restored to available.`
        );

        res.json({ message: 'Payment rejected. Transaction cancelled. Product restored to available.' });
    } catch (err) {
        sendError(res, 'Reject Payment Error', err);
    }
});

// -------------------------------------------------------
// SECTION D: ADMIN OVERVIEW
// -------------------------------------------------------

// --- D0. OPEN USER REPORTS ---
router.get('/reports/open', auth, adminOnly, async (req, res) => {
    try {
        const reports = await Report.find({ Status: 'Open' }, NO_ID).sort({ DateCreated: -1 }).lean();
        const reporters = await User.find(
            { UserID: { $in: reports.map((report) => report.ReporterID) } },
            { ...NO_ID, UserID: 1, FirstName: 1, LastName: 1, Email: 1 }
        ).lean();
        const reporterMap = indexBy(reporters, 'UserID');

        res.json(reports.map((report) => {
            const reporter = reporterMap.get(report.ReporterID);
            return {
                ...report,
                ReporterName: reporter ? `${reporter.FirstName} ${reporter.LastName}` : 'Deleted account',
                ReporterEmail: reporter?.Email ?? null
            };
        }));
    } catch (err) {
        sendError(res, 'Get Open Reports Error', err);
    }
});

router.get('/reports/stats', auth, adminOnly, async (req, res) => {
    try {
        const monthlyStart = new Date();
        monthlyStart.setUTCDate(1);
        monthlyStart.setUTCHours(0, 0, 0, 0);
        monthlyStart.setUTCMonth(monthlyStart.getUTCMonth() - 5);
        const [reportTotals, reportTypes, reportReasons, reportTrend, completedSales, purchaseTrend, buyerTotals, categoryTotals] = await Promise.all([
            Report.aggregate([
                {
                    $group: {
                        _id: '$Status',
                        count: { $sum: 1 }
                    }
                }
            ]),
            Report.aggregate([
                { $group: { _id: '$TargetType', count: { $sum: 1 } } },
                { $sort: { count: -1, _id: 1 } }
            ]),
            Report.aggregate([
                { $group: { _id: '$Reason', count: { $sum: 1 } } },
                { $sort: { count: -1, _id: 1 } },
                { $limit: 5 }
            ]),
            Report.aggregate([
                { $match: { DateCreated: { $gte: monthlyStart } } },
                {
                    $group: {
                        _id: { $dateToString: { format: '%Y-%m', date: '$DateCreated' } },
                        count: { $sum: 1 }
                    }
                },
                { $sort: { _id: 1 } }
            ]),
            Transaction.countDocuments({ Status: 'Completed' }),
            Transaction.aggregate([
                { $match: { Status: 'Completed', TransactionDate: { $gte: monthlyStart } } },
                {
                    $group: {
                        _id: { $dateToString: { format: '%Y-%m', date: '$TransactionDate' } },
                        count: { $sum: 1 }
                    }
                },
                { $sort: { _id: 1 } }
            ]),
            Transaction.aggregate([
                { $match: { Status: 'Completed' } },
                { $group: { _id: '$BuyerID', purchases: { $sum: 1 } } },
                { $sort: { purchases: -1, _id: 1 } },
                { $limit: 5 }
            ]),
            Transaction.aggregate([
                { $match: { Status: 'Completed' } },
                {
                    $lookup: {
                        from: Product.collection.name,
                        localField: 'ProductID',
                        foreignField: 'ProductID',
                        as: 'product'
                    }
                },
                { $unwind: '$product' },
                {
                    $lookup: {
                        from: Category.collection.name,
                        localField: 'product.CategoryID',
                        foreignField: 'CategoryID',
                        as: 'category'
                    }
                },
                { $unwind: { path: '$category', preserveNullAndEmptyArrays: true } },
                {
                    $group: {
                        _id: '$product.CategoryID',
                        name: { $first: '$category.CategoryName' },
                        sales: { $sum: 1 }
                    }
                },
                { $sort: { sales: -1, name: 1 } },
                { $limit: 5 }
            ])
        ]);

        const reportCounts = reportTotals.reduce((counts, row) => {
            counts[row._id] = row.count;
            return counts;
        }, {});
        const trendMap = new Map(reportTrend.map((row) => [row._id, row.count]));
        const purchaseTrendMap = new Map(purchaseTrend.map((row) => [row._id, row.count]));
        const monthlyReports = Array.from({ length: 6 }, (_, index) => {
            const month = new Date(monthlyStart);
            month.setUTCMonth(month.getUTCMonth() + index);
            const key = `${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, '0')}`;
            return {
                Month: key,
                Label: month.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }),
                Reports: trendMap.get(key) || 0,
                Purchases: purchaseTrendMap.get(key) || 0
            };
        });
        const topBuyerIDs = buyerTotals.map((buyer) => buyer._id);
        const [buyers, uniqueBuyers] = await Promise.all([
            User.find(
                { UserID: { $in: topBuyerIDs } },
                { ...NO_ID, UserID: 1, FirstName: 1, LastName: 1 }
            ).lean(),
            Transaction.distinct('BuyerID', { Status: 'Completed' })
        ]);
        const buyerMap = indexBy(buyers, 'UserID');

        res.json({
            reports: {
                total: Object.values(reportCounts).reduce((sum, count) => sum + count, 0),
                open: reportCounts.Open || 0,
                resolved: reportCounts.Resolved || 0,
                dismissed: reportCounts.Dismissed || 0,
                byTargetType: reportTypes.map((row) => ({ TargetType: row._id, Count: row.count })),
                topReasons: reportReasons.map((row) => ({ Reason: row._id, Count: row.count })),
                monthly: monthlyReports.map(({ Month, Label, Reports }) => ({ Month, Label, Reports }))
            },
            purchasesMonthly: monthlyReports.map(({ Month, Label, Purchases }) => ({ Month, Label, Purchases })),
            completedSales,
            uniqueBuyers: uniqueBuyers.length,
            topBuyers: buyerTotals.map((buyer) => {
                const user = buyerMap.get(buyer._id);
                return {
                    BuyerID: buyer._id,
                    BuyerName: user ? `${user.FirstName} ${user.LastName}` : 'Deleted account',
                    Purchases: buyer.purchases
                };
            }),
            topCategories: categoryTotals.map((category) => ({
                CategoryID: category._id,
                CategoryName: category.name || 'Uncategorized',
                Sales: category.sales
            }))
        });
    } catch (err) {
        sendError(res, 'Get Report Stats Error', err);
    }
});

router.patch('/reports/:id/status', auth, adminOnly, async (req, res) => {
    const reportID = toInt(req.params.id);
    const status = req.body.status;
    if (!['Resolved', 'Dismissed'].includes(status)) {
        return res.status(400).json({ message: 'Report status must be Resolved or Dismissed.' });
    }

    try {
        const openReport = reportID === null ? null : await Report.findOne(
            { ReportID: reportID, Status: 'Open' },
            { ...NO_ID, ReportID: 1, TargetType: 1, TargetID: 1 }
        ).lean();
        if (!openReport) return res.status(404).json({ message: 'Open report not found.' });

        let actionMessage = '';
        if (status === 'Resolved' && openReport.TargetType === 'Listing') {
            const result = await Product.updateOne(
                { ProductID: openReport.TargetID, Status: { $ne: 'Hidden' } },
                { $set: { Status: 'Hidden' } },
                { runValidators: true }
            );
            if (!result.matchedCount) {
                const alreadyHidden = await Product.exists({ ProductID: openReport.TargetID, Status: 'Hidden' });
                if (!alreadyHidden) return res.status(404).json({ message: 'Reported listing no longer exists.' });
            }
            actionMessage = ' The reported listing has been hidden.';
        } else if (status === 'Resolved' && openReport.TargetType === 'Account') {
            const result = await User.updateOne(
                { UserID: openReport.TargetID, IsAdmin: { $ne: true } },
                { $set: { IsDisabled: true } }
            );
            if (!result.matchedCount) return res.status(404).json({ message: 'Reported account no longer exists.' });
            actionMessage = ' The reported account has been disabled.';
        }

        const report = await Report.findOneAndUpdate(
            { ReportID: reportID, Status: 'Open' },
            { $set: { Status: status, ReviewedBy: req.user.id, ReviewedAt: new Date() } },
            { new: true, projection: { ReportID: 1 } }
        ).lean();
        if (!report) return res.status(404).json({ message: 'Open report not found.' });

        res.json({ message: `Report ${status.toLowerCase()}.${actionMessage}` });
    } catch (err) {
        sendError(res, 'Update Report Status Error', err);
    }
});

// --- D1. GET PENDING COUNTS (for admin dashboard badges) ---
// GET /api/admin/counts
// Returns pending counts for all three approval sections
router.get('/counts', auth, adminOnly, async (req, res) => {
    try {
        const sellerIDs = await User.distinct('UserID', { IsAdmin: { $ne: true }, IsDisabled: { $ne: true } });
        const [pendingAccounts, approvedAccounts, rejectedAccounts, totalAccounts, pendingListings, pendingPayments, totalListings, openReports] = await Promise.all([
            User.countDocuments({ IsApproved: false, IsRejected: { $ne: true }, IsAdmin: { $ne: true } }),
            User.countDocuments({ IsApproved: true, IsAdmin: { $ne: true } }),
            User.countDocuments({ IsRejected: true, IsAdmin: { $ne: true } }),
            User.countDocuments({ IsAdmin: { $ne: true } }),
            Product.countDocuments({ UserID: { $in: sellerIDs }, Status: 'Pending Approval' }),
            Transaction.countDocuments({ Status: 'Pending' }),
            Product.countDocuments({ UserID: { $in: sellerIDs }, Status: { $in: ['Available', 'Sold'] } }),
            Report.countDocuments({ Status: 'Open' })
        ]);

        res.json({ pendingAccounts, approvedAccounts, rejectedAccounts, totalAccounts, pendingListings, pendingPayments, totalListings, openReports });
    } catch (err) {
        sendError(res, 'Get Admin Counts Error', err);
    }
});

module.exports = router;
