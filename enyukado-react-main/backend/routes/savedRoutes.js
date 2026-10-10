const express = require('express');
const router  = express.Router();
const auth    = require('../middleware/auth');
const { SavedItem, Product, Category, User, nextId, NO_ID } = require('../models');
const { toInt, indexBy, sendError } = require('../utils/helpers');

// --- 1. GET MY SAVED ITEMS ---
router.get('/', auth, async (req, res) => {
    try {
        const saved = await SavedItem.find({ UserID: req.user.id }, NO_ID)
            .sort({ DateSaved: -1 })
            .lean();

        const products   = await Product.find(
            { ProductID: { $in: saved.map(s => s.ProductID) }, Status: { $ne: 'Hidden' } }, NO_ID
        ).lean();
        const sellerIDs  = [...new Set(products.map((product) => product.UserID))];
        const sellers    = await User.distinct('UserID', {
            UserID: { $in: sellerIDs }, IsAdmin: { $ne: true }, IsDisabled: { $ne: true }
        });
        const visibleSellerIDs = new Set(sellers);
        const visibleProducts = products.filter((product) => visibleSellerIDs.has(product.UserID));
        const categories = await Category.find({ CategoryID: { $in: visibleProducts.map(p => p.CategoryID) } }, NO_ID).lean();
        const productMap  = indexBy(visibleProducts, 'ProductID');
        const categoryMap = indexBy(categories, 'CategoryID');

        // Same shape as the old SQL JOIN (rows whose product/category no longer exist are dropped)
        const rows = [];
        for (const s of saved) {
            const p = productMap.get(s.ProductID);
            const c = p && categoryMap.get(p.CategoryID);
            if (!p || !c) continue;
            rows.push({
                SavedID:          s.SavedID,
                DateSaved:        s.DateSaved,
                ProductID:        p.ProductID,
                ProductName:      p.ProductName,
                Price:            p.Price,
                ImageURL:         p.ImageURL,
                ProductCondition: p.ProductCondition,
                Status:           p.Status,
                Quantity:         p.Quantity,
                sellerName:       p.sellerName,
                CategoryName:     c.CategoryName
            });
        }

        res.json(rows);
    } catch (err) {
        sendError(res, 'Get Saved Items Error', err);
    }
});

// --- 2. SAVE AN ITEM ---
router.post('/', auth, async (req, res) => {
    const productID = toInt(req.body.productID);
    if (productID === null) return res.status(400).json({ message: 'productID is required.' });

    try {
        const existing = await SavedItem.exists({ UserID: req.user.id, ProductID: productID });
        if (existing) {
            return res.status(400).json({ message: 'Item already saved.' });
        }

        const product = await Product.findOne(
            { ProductID: productID, Status: { $ne: 'Hidden' } },
            { UserID: 1 }
        ).lean();
        const sellerIsVisible = product && await User.exists({
            UserID: product.UserID, IsAdmin: { $ne: true }, IsDisabled: { $ne: true }
        });
        if (!product || !sellerIsVisible) {
            return res.status(404).json({ message: 'Product not found.' });
        }

        await SavedItem.create({
            SavedID:   await nextId('SavedID'),
            UserID:    req.user.id,
            ProductID: productID
        });

        res.status(201).json({ message: 'Item saved!' });
    } catch (err) {
        // (UserID, ProductID) unique index — double-click / race
        if (err.code === 11000) {
            return res.status(400).json({ message: 'Item already saved.' });
        }
        sendError(res, 'Save Item Error', err);
    }
});

// --- 3. UNSAVE AN ITEM ---
router.delete('/:productID', auth, async (req, res) => {
    try {
        const productID = toInt(req.params.productID);
        if (productID !== null) {
            await SavedItem.deleteOne({ UserID: req.user.id, ProductID: productID });
        }

        res.json({ message: 'Item removed from saved.' });
    } catch (err) {
        sendError(res, 'Unsave Item Error', err);
    }
});

// --- 4. CHECK IF ITEM IS SAVED ---
router.get('/check/:productID', auth, async (req, res) => {
    try {
        const productID = toInt(req.params.productID);
        const saved = productID !== null &&
            !!(await SavedItem.exists({ UserID: req.user.id, ProductID: productID }));

        res.json({ saved });
    } catch (err) {
        sendError(res, 'Check Saved Error', err);
    }
});

module.exports = router;
