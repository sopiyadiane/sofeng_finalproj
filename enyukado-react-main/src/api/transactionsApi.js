import { apiClient } from './client.js';

export function submitPurchase(formData, token) {
  return apiClient.postForm('/transactions', formData, { token });
}

export function getMyPurchases(token) {
  return apiClient.get('/transactions/my/purchases', { token });
}

export function getMySales(token) {
  return apiClient.get('/transactions/my/sales', { token });
}

export function updateShippingStatus(transactionId, shippingDetails, token) {
  return apiClient.patch(`/transactions/${transactionId}/shipping-status`, shippingDetails, { token });
}

export function confirmPickup(transactionId, token) {
  return apiClient.patch(`/transactions/${transactionId}/complete`, undefined, { token });
}
