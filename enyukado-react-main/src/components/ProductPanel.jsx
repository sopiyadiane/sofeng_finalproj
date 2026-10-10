import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { deleteProduct, getProduct } from '../api/productsApi.js';
import { saveItem, unsaveItem, checkSaved } from '../api/savedApi.js';
import { getReviewsForProduct, getReviewsForUser } from '../api/reviewsApi.js';
import { createReport } from '../api/reportsApi.js';
import AppHeader from './AppHeader.jsx';
import './ProductPanel.css';

function timeAgo(date) {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function ProductPanel({
  productID,
  token,
  myUserID,
  onBack,
  onPush,
  onToast,
  onOpenPayment,
  onOpenCategory,
  onDeleted,
  cart,
  headerProps,
}) {
  const navigate = useNavigate();
  const [product, setProduct] = useState(null);
  const [activeImg, setActiveImg] = useState(null);
  const [saved, setSaved] = useState(false);
  const [heartPop, setHeartPop] = useState(false);
  const [rating, setRating] = useState('—');
  const [productRating, setProductRating] = useState('—');
  const [productReviewCount, setProductReviewCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [descOpen, setDescOpen] = useState(false);
  const [reportTarget, setReportTarget] = useState(null);
  const [reportReason, setReportReason] = useState('');
  const [otherReportReason, setOtherReportReason] = useState('');
  const [reportDetails, setReportDetails] = useState('');
  const [reportSubmitting, setReportSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    setDescOpen(false);
    setProductRating('—');
    setProductReviewCount(0);
    getProduct(productID)
      .then(async (p) => {
        if (cancelled) return;
        setProduct(p);
        const images = p.images?.length ? p.images : p.ImageURL ? [{ ImageURL: p.ImageURL }] : [];
        setActiveImg(images[0]?.ImageURL || null);
        if (token) {
          try {
            const { saved } = await checkSaved(productID, token);
            if (!cancelled) setSaved(saved);
          } catch {
            /* ignore */
          }
        }
        try {
          const reviewData = await getReviewsForUser(p.UserID);
          if (!cancelled) setRating(reviewData.averageRating || '—');
        } catch {
          /* ignore */
        }
        try {
          const productReviewData = await getReviewsForProduct(p.ProductID);
          if (!cancelled) {
            setProductRating(productReviewData.averageRating || '—');
            setProductReviewCount(productReviewData.totalReviews || 0);
          }
        } catch {
          /* ignore */
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err.status === 404 ? 'This listing is no longer available.' : 'Could not load this listing. Please try again.');
        onToast?.(err.message || 'Failed to load product.', 'error');
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [productID, token]);

  if (loading) {
    return (
      <div className="fullpanel-overlay">
        <AppHeader {...headerProps} within="browse" onBack={onBack} crumbs={[{ label: 'Browse' }, { label: 'Product' }]} />
        <div className="fullpanel-body pp-loading-skeleton" aria-label="Loading product">
          <div className="skeleton-shimmer pp-loading-image" />
          <div className="pp-loading-info">
            <div className="skeleton-shimmer pp-loading-line short" />
            <div className="skeleton-shimmer pp-loading-line title" />
            <div className="skeleton-shimmer pp-loading-line" />
            <div className="skeleton-shimmer pp-loading-line" />
          </div>
        </div>
      </div>
    );
  }

  if (loadError || !product) {
    return (
      <div className="fullpanel-overlay">
        <AppHeader {...headerProps} within="browse" onBack={onBack} crumbs={[{ label: 'Browse' }, { label: 'Product' }]} />
        <div className="fullpanel-body pp-not-found">
          <h1>{loadError || 'This listing is no longer available.'}</h1>
          <button type="button" onClick={onBack}>Back to browsing</button>
        </div>
      </div>
    );
  }

  const images = product.images?.length ? product.images : product.ImageURL ? [{ ImageURL: product.ImageURL }] : [];
  const isMine = product.UserID === myUserID;
  const sellerInitials = product.SellerFirstName && product.SellerLastName
    ? (product.SellerFirstName[0] + product.SellerLastName[0]).toUpperCase()
    : (product.sellerName ? product.sellerName[0].toUpperCase() : '?');
  const sellerName = product.sellerName || `${product.SellerFirstName || ''} ${product.SellerLastName || ''}`.trim() || 'Unknown';
  // Brand new / Like new / Lightly used -> green, Well used -> orange, Heavily used -> red
  // (legacy Used/Fair/Poor values are still colour-coded so old listings look right)
  const condColor = ['Well used', 'Used', 'Fair'].includes(product.ProductCondition) ? 'fair'
    : ['Heavily used', 'Poor'].includes(product.ProductCondition) ? 'poor' : '';
  const postedAgo = product.DatePosted ? timeAgo(new Date(product.DatePosted)) : 'Recently';
  const outOfStock = product.Quantity <= 0 || product.Status === 'Sold';
  const inCart = cart?.isInCart(product.ProductID);

  const categoryName = product.CategoryName || 'Others';
  const crumbs = [
    { label: 'Browse' },
    {
      label: categoryName,
      onClick: onOpenCategory && product.CategoryID != null ? () => onOpenCategory(product.CategoryID) : undefined,
    },
    { label: product.ProductName },
  ];

  const paymentPayload = {
    productID: product.ProductID,
    name: product.ProductName,
    price: product.Price,
    imgUrl: images[0]?.ImageURL || '',
    sellerName,
    sellerID: product.UserID,
    qrCode: product.QRCodeImage || '',
  };

  async function toggleSave() {
    if (!token) return;
    const next = !saved;
    setSaved(next);
    setHeartPop(true);
    setTimeout(() => setHeartPop(false), 450);
    try {
      if (next) {
        await saveItem(product.ProductID, token);
        onToast?.('Saved! View in your profile → Saved tab.');
      } else {
        await unsaveItem(product.ProductID, token);
        onToast?.('Removed from saved items.');
      }
    } catch {
      setSaved(!next);
    }
  }

  function goToSellerProfile() {
    if (String(product.UserID) === String(myUserID)) navigate('/profile');
    else navigate(`/profile?id=${product.UserID}`);
  }

  function openReport(targetType, targetID, targetName) {
    if (!token) {
      onToast?.('Log in to report a listing or account.', 'error');
      navigate('/');
      return;
    }
    setReportTarget({ targetType, targetID, targetName });
    setReportReason('');
    setOtherReportReason('');
    setReportDetails('');
  }

  async function submitReport(event) {
    event.preventDefault();
    if (!reportTarget || !reportReason || (reportReason === 'Other' && !otherReportReason.trim())) {
      onToast?.('Please choose a reason and provide it if you select Other.', 'error');
      return;
    }
    if (!reportDetails.trim()) {
      onToast?.('Please provide details for the report.', 'error');
      return;
    }
    setReportSubmitting(true);
    try {
      const response = await createReport({
        ...reportTarget,
        reason: reportReason,
        customReason: otherReportReason.trim(),
        details: reportDetails.trim()
      }, token);
      onToast?.(response.message || 'Report submitted.');
      setReportTarget(null);
    } catch (err) {
      onToast?.(err.message || 'Could not submit report.', 'error');
    } finally {
      setReportSubmitting(false);
    }
  }

  async function handleDeleteListing() {
    if (!window.confirm(`Delete "${product.ProductName}"? This cannot be undone.`)) return;
    try {
      await deleteProduct(product.ProductID, token);
      onToast?.('Listing deleted.');
      onDeleted?.();
    } catch (err) {
      onToast?.(err.message || 'Failed to delete listing.', 'error');
    }
  }

  function editListing() {
    navigate('/sell', {
      state: {
        editData: {
          productID: product.ProductID,
          name: product.ProductName,
          price: product.Price,
          categoryID: product.CategoryID,
          condition: product.ProductCondition,
          description: product.Description || '',
          quantity: product.Quantity,
        },
      },
    });
  }

  const description = (product.Description || '').trim();
  const descLong = description.length > 320 || description.split('\n').length > 6;
  const priceText = `₱${parseFloat(product.Price).toLocaleString()}`;

  return (
    <div className="fullpanel-overlay">
      <AppHeader {...headerProps} within="browse" onBack={onBack} crumbs={crumbs} />

      <div className="fullpanel-body">
        <div className="pp-wrap">
          {/* ---------- Top: photos on the left, the essentials on the right ---------- */}
          <div className={`pp-top${images.length > 1 ? ' has-thumbs' : ''}`}>
            {/* ---------- Gallery ---------- */}
            <div className="pp-gallery">
              <div className="pp-main">
                {activeImg ? <img src={activeImg} alt={product.ProductName} /> : <div className="pp-main-empty">📦</div>}
                {outOfStock && <span className="pp-sold">Sold out</span>}
              </div>
              {images.length > 1 && (
                <div className="pp-thumbs">
                  {images.map((img, i) => (
                    <button
                      key={i}
                      type="button"
                      className={`pp-thumb${img.ImageURL === activeImg ? ' active' : ''}`}
                      onClick={() => setActiveImg(img.ImageURL)}
                    >
                      <img src={img.ImageURL} alt="" />
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="pp-info">
              <div className="pp-card">
                <div className="pp-tags">
                  <span className="pp-tag cat">{product.CategoryName || 'Others'}</span>
                  <span className={`pp-tag cond ${condColor}`}>{product.ProductCondition}</span>
                </div>

                <div className="pp-title-row">
                  <h1 className="pp-title">{product.ProductName}</h1>
                  {token && (
                    <button
                      type="button"
                      className={`pp-save${saved ? ' saved' : ''}${heartPop ? ' pop' : ''}`}
                      title={saved ? 'Remove from saved' : 'Save for later'}
                      onClick={toggleSave}
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                        <path
                          d="M6 3h12a1 1 0 011 1v17l-7-4.5L5 21V4a1 1 0 011-1z"
                          fill={saved ? 'currentColor' : 'none'}
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinejoin="round"
                        />
                      </svg>
                      <span>{saved ? 'Saved' : 'Save'}</span>
                    </button>
                  )}
                </div>

                <div className="pp-price-row">
                  <div className="pp-price">{priceText}</div>
                  <span className="pp-posted">Posted {postedAgo}</span>
                  <span className="pp-product-rating" aria-label={`${productRating} product rating from ${productReviewCount} reviews`}>
                    ★ {productRating} product rating{productReviewCount ? ` · ${productReviewCount}` : ''}
                  </span>
                </div>

                {!outOfStock && (
                  <div className="pp-facts">
                    <div className="pp-fact">
                      <span className="pp-fact-label">Available</span>
                      <span className="pp-fact-value">{product.Quantity} {product.Quantity === 1 ? 'unit' : 'units'}</span>
                    </div>
                  </div>
                )}

                {!isMine ? (
                  <div className="pp-actions">
                    <button
                      className="btn-buy"
                      disabled={outOfStock}
                      onClick={() => onOpenPayment(paymentPayload)}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" /><line x1="3" y1="6" x2="21" y2="6" /><path d="M16 10a4 4 0 01-8 0" /></svg>
                      {outOfStock ? 'Out of Stock' : 'Buy Now'}
                    </button>
                    <button
                      className={`btn-add-cart${inCart ? ' added' : ''}`}
                      disabled={outOfStock && !inCart}
                      title={inCart ? 'Click to remove from cart' : undefined}
                      onClick={() => {
                        if (inCart) {
                          cart?.removeFromCart(product.ProductID);
                          onToast?.('Removed from cart.', 'success', { action: { label: 'Undo', onClick: () => cart?.addToCart(paymentPayload) } });
                          return;
                        }
                        cart?.addToCart(paymentPayload);
                        onToast?.('Added to cart!', 'success', { action: { label: 'Undo', onClick: () => cart?.removeFromCart(product.ProductID) } });
                      }}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><circle cx="9" cy="21" r="1" /><circle cx="20" cy="21" r="1" /><path d="M1 1h4l2.68 13.39a2 2 0 002 1.61h9.72a2 2 0 002-1.61L23 6H6" /></svg>
                      {inCart ? (<><span className="cart-lbl-in">In Cart</span><span className="cart-lbl-remove">Remove from Cart</span></>) : 'Add to Cart'}
                    </button>
                  </div>
                ) : (
                  <div className="pp-own-actions">
                    <span className="pp-own-note">This is your listing.</span>
                    <div className="pp-owner-buttons">
                      <button type="button" className="pp-owner-edit" onClick={editListing}>Edit</button>
                      <button type="button" className="pp-owner-delete" onClick={handleDeleteListing}>Delete</button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* ---------- Below: the long stuff, full width ---------- */}
          <div className="pp-below">
            <div className="pp-seller" onClick={goToSellerProfile}>
              <div className="pp-seller-avatar">{sellerInitials}</div>
              <div className="pp-seller-info">
                <span className="pp-seller-label">Sold by</span>
                <span className="pp-seller-name">{sellerName}</span>
                <span className="pp-seller-rating">⭐ {rating}</span>
              </div>
              {!isMine && (
                <div className="pp-seller-buttons">
                  <button
                    type="button"
                    className="pp-seller-msg"
                    onClick={(e) => {
                      e.stopPropagation();
                      onPush({ type: 'messages', userID: product.UserID, userName: sellerName });
                    }}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" /></svg>
                    Message
                  </button>
                  <button
                    type="button"
                    className="pp-report-link"
                    onClick={(e) => {
                      e.stopPropagation();
                      openReport('account', product.UserID, sellerName);
                    }}
                  >
                    Report account
                  </button>
                </div>
              )}
            </div>

            <div className="pp-about">
              <div className="pp-about-head">
                <h2 className="pp-label">About this item</h2>
                {!isMine && (
                  <button type="button" className="pp-report-link" onClick={() => openReport('listing', product.ProductID, product.ProductName)}>
                    Report listing
                  </button>
                )}
              </div>
              {/* white-space: pre-wrap (see CSS) keeps the seller's line breaks */}
              <p className={`pp-desc${descLong && !descOpen ? ' clamped' : ''}`}>
                {description || 'No description provided.'}
              </p>
              {descLong && (
                <button type="button" className="pp-more" onClick={() => setDescOpen((o) => !o)}>
                  {descOpen ? 'Show less' : 'Read more'}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {reportTarget && (
        <div className="pp-report-backdrop" onClick={() => !reportSubmitting && setReportTarget(null)}>
          <form className="pp-report-dialog" role="dialog" aria-modal="true" aria-labelledby="pp-report-title" onSubmit={submitReport} onClick={(e) => e.stopPropagation()}>
            <h2 id="pp-report-title">Report {reportTarget.targetType}</h2>
            <p>Tell Enyukado admins why you’re reporting “{reportTarget.targetName}”.</p>
            <label htmlFor="pp-report-reason">Reason</label>
            <select id="pp-report-reason" value={reportReason} required onChange={(e) => {
              setReportReason(e.target.value);
              setOtherReportReason('');
            }}>
              <option value="">Choose a reason</option>
              <option>Scam or fraud</option>
              <option>Prohibited or unsafe item</option>
              <option>Misleading information</option>
              <option>Inappropriate content</option>
              <option>Impersonation</option>
              <option>Other</option>
            </select>
            {reportReason === 'Other' && (
              <>
                <label htmlFor="pp-report-other-reason">Please specify the reason</label>
                <textarea
                  id="pp-report-other-reason"
                  rows="2"
                  maxLength="200"
                  value={otherReportReason}
                  onChange={(e) => setOtherReportReason(e.target.value)}
                  placeholder="Enter the reason for your report"
                  required
                />
              </>
            )}
            <label htmlFor="pp-report-details">Details (required)</label>
            <textarea id="pp-report-details" rows="4" maxLength="1000" value={reportDetails} onChange={(e) => setReportDetails(e.target.value)} placeholder="Add details to help the admin review" required />
            <div className="pp-report-actions">
              <button type="button" disabled={reportSubmitting} onClick={() => setReportTarget(null)}>Cancel</button>
              <button
                type="submit"
                disabled={reportSubmitting || !reportReason || (reportReason === 'Other' && !otherReportReason.trim()) || !reportDetails.trim()}
              >
                {reportSubmitting ? 'Submitting…' : 'Submit report'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}