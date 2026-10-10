import { apiClient } from './client.js';

export function getReviewsForUser(userId) {
  return apiClient.get(`/reviews/user/${userId}`);
}

export function getReviewsForProduct(productId) {
  return apiClient.get(`/reviews/product/${productId}`);
}

export function submitReview(body, token) {
  return apiClient.post('/reviews', body, { token });
}
