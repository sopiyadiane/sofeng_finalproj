const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { Review, Transaction, User, Product, nextId, NO_ID } = require('../models');
const { toInt, indexBy, sendError } = require('../utils/helpers');

// Build the review shape the frontend expects (review + reviewer name + product name)
async function toReviewRows(reviews) {
    const transactions = await Transaction.find(
        { TransactionID: { $in: reviews.map(r => r.TransactionID) } }, NO_ID
    ).lean();
    const [reviewers, products] = await Promise.all([
        User.find({ UserID: { $in: reviews.map(r => r.ReviewerID) } }, { ...NO_ID, UserID: 1, FirstName: 1, LastName: 1 }).lean(),
        Product.find({ ProductID: { $in: transactions.map(t => t.ProductID) } }, { ...NO_ID, ProductID: 1, ProductName: 1 }).lean()
    ]);

    const txMap       = indexBy(transactions, 'TransactionID');
    const reviewerMap = indexBy(reviewers, 'UserID');
    const productMap  = indexBy(products, 'ProductID');

    // INNER JOIN semantics: drop reviews whose transaction / reviewer / product is gone
    const rows = [];
    for (const r of reviews) {
        const t = txMap.get(r.TransactionID);
        const u = reviewerMap.get(r.ReviewerID);
        const p = t && productMap.get(t.ProductID);
        if (!t || !u || !p) continue;
        rows.push({
            ReviewID:          r.ReviewID,
            Rating:            r.SellerRating ?? r.Rating,
            SellerRating:      r.SellerRating ?? r.Rating,
            ProductRating:     r.ProductRating ?? null,
            Comment:           r.Comment,
            DateCreated:       r.DateCreated,
            ReviewerFirstName: u.FirstName,
            ReviewerLastName:  u.LastName,
            ProductName:       p.ProductName
        });
    }
    return rows;
}

// --- 1. SUBMIT A REVIEW (Private - Buyer only) ---
// Rules:
//   - Must have a Completed transaction with that seller
//   - Can only review once per transaction
//   - Rating must be between 1 and 5
router.post('/', auth, async (req, res) => {
    const { transactionID, comment } = req.body;
    const sellerRating = req.body.sellerRating ?? req.body.rating;
    const productRating = req.body.productRating;
    const reviewerID = req.user.id;

    if (!transactionID || (sellerRating == null && productRating == null)) {
        return res.status(400).json({ message: 'TransactionID and at least one rating are required.' });
    }

    const validRating = (value) => Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 5;
    if ((sellerRating != null && !validRating(sellerRating)) ||
        (productRating != null && !validRating(productRating))) {
        return res.status(400).json({ message: 'Ratings must be whole numbers between 1 and 5.' });
    }

    try {
        // Verify the transaction exists, is Completed, and the reviewer is the buyer
        const txID = toInt(transactionID);
        const transaction = txID === null ? null
            : await Transaction.findOne({ TransactionID: txID }, { BuyerID: 1, SellerID: 1, ProductID: 1, Status: 1 }).lean();

        if (!transaction) {
            return res.status(404).json({ message: 'Transaction not found.' });
        }

        // Only the buyer can leave a review
        if (transaction.BuyerID !== reviewerID) {
            return res.status(403).json({ message: 'Only the buyer can leave a review.' });
        }

        // Transaction must be completed
        if (transaction.Status !== 'Completed') {
            return res.status(400).json({ message: 'You can only review after the transaction is completed.' });
        }

        const existingReview = await Review.findOne({ TransactionID: txID }).lean();
        if (existingReview) {
            if (existingReview.ReviewerID === reviewerID &&
                productRating != null &&
                existingReview.ProductRating == null &&
                (sellerRating == null || Number(sellerRating) === (existingReview.SellerRating ?? existingReview.Rating))) {
                await Review.updateOne(
                    { TransactionID: txID, ReviewerID: reviewerID, ProductRating: null },
                    { $set: { ProductRating: Number(productRating) } }
                );
                const updatedReview = await Review.findOne({ TransactionID: txID }, { ProductRating: 1 }).lean();
                if (updatedReview?.ProductRating === Number(productRating)) {
                    return res.json({ message: 'Product rating submitted successfully!', reviewId: existingReview.ReviewID });
                }
            }
            return res.status(400).json({ message: 'You have already reviewed this transaction.' });
        }
        if (sellerRating == null) {
            return res.status(400).json({ message: 'A seller rating is required when submitting the first review.' });
        }

        const reviewID = await nextId('ReviewID');
        await Review.create({
            ReviewID:      reviewID,
            TransactionID: txID,
            ReviewerID:    reviewerID,
            Rating:       Number(sellerRating),
            SellerRating: Number(sellerRating),
            ...(productRating == null ? {} : { ProductRating: Number(productRating) }),
            Comment:       comment || null
        });

        res.status(201).json({ message: 'Review submitted successfully!', reviewId: reviewID });
    } catch (err) {
        // Unique index on TransactionID — two simultaneous submissions
        if (err.code === 11000) {
            return res.status(400).json({ message: 'You have already reviewed this transaction.' });
        }
        sendError(res, 'Submit Review Error', err);
    }
});

// --- 2. GET REVIEWS FOR A USER (Public) ---
// Returns all reviews received by a specific seller
// Also returns their average rating
router.get('/user/:userID', async (req, res) => {
    const sellerID = toInt(req.params.userID);

    try {
        // Reviews where the reviewed user is the seller in the transaction
        const sellerTx = sellerID === null ? []
            : await Transaction.find({ SellerID: sellerID }, { TransactionID: 1 }).lean();

        const found = await Review
            .find({ TransactionID: { $in: sellerTx.map(t => t.TransactionID) } }, NO_ID)
            .sort({ DateCreated: -1 })
            .lean();

        const reviews = await toReviewRows(found);

        // Calculate average rating
        const avgRating = reviews.length > 0
            ? (reviews.reduce((sum, r) => sum + (r.SellerRating ?? r.Rating), 0) / reviews.length).toFixed(1)
            : null;

        res.json({
            totalReviews: reviews.length,
            averageRating: avgRating,
            reviews
        });
    } catch (err) {
        sendError(res, 'Get Reviews Error', err);
    }
});

// --- 2b. GET REVIEWS FOR A PRODUCT (Public) ---
router.get('/product/:productID', async (req, res) => {
    const productID = toInt(req.params.productID);
    try {
        const productTransactions = productID === null ? []
            : await Transaction.find({ ProductID: productID }, { TransactionID: 1 }).lean();
        const reviews = await Review.find(
            { TransactionID: { $in: productTransactions.map((transaction) => transaction.TransactionID) }, ProductRating: { $type: 'number' } },
            { ...NO_ID, ProductRating: 1 }
        ).lean();
        const averageRating = reviews.length
            ? (reviews.reduce((sum, review) => sum + review.ProductRating, 0) / reviews.length).toFixed(1)
            : null;
        res.json({ totalReviews: reviews.length, averageRating });
    } catch (err) {
        sendError(res, 'Get Product Reviews Error', err);
    }
});

// --- 3. GET REVIEW BY TRANSACTION ID (Private) ---
// Used by frontend to check if buyer already reviewed a transaction
router.get('/transaction/:transactionID', auth, async (req, res) => {
    try {
        const txID = toInt(req.params.transactionID);
        const review = txID === null ? null : await Review.findOne(
            { TransactionID: txID, ReviewerID: req.user.id },
            { ...NO_ID, ReviewID: 1, Rating: 1, SellerRating: 1, ProductRating: 1, Comment: 1, DateCreated: 1 }
        ).lean();

        if (!review) {
            return res.status(404).json({ message: 'No review found.' });
        }
        res.json(review);
    } catch (err) {
        sendError(res, 'Get Review by Transaction Error', err);
    }
});

// --- 4. GET SINGLE REVIEW BY ID (Public) ---
router.get('/:id', async (req, res) => {
    try {
        const id = toInt(req.params.id);
        const review = id === null ? null : await Review.findOne({ ReviewID: id }, NO_ID).lean();
        const rows   = review ? await toReviewRows([review]) : [];

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Review not found.' });
        }

        res.json(rows[0]);
    } catch (err) {
        sendError(res, 'Get Review Error', err);
    }
});

// --- 5. DELETE A REVIEW (Private - Reviewer only) ---
router.delete('/:id', auth, async (req, res) => {
    const reviewID = toInt(req.params.id);
    const userID   = req.user.id;

    try {
        const review = reviewID === null ? null
            : await Review.findOne({ ReviewID: reviewID }, { ReviewerID: 1 }).lean();

        if (!review) {
            return res.status(404).json({ message: 'Review not found.' });
        }
        if (review.ReviewerID !== userID) {
            return res.status(403).json({ message: 'Unauthorized: You did not write this review.' });
        }

        await Review.deleteOne({ ReviewID: reviewID });

        res.json({ message: 'Review deleted successfully!' });
    } catch (err) {
        sendError(res, 'Delete Review Error', err);
    }
});

module.exports = router;
