import { apiClient } from './client.js';

export function createReport({ targetType, targetID, reason, customReason, details }, token) {
  return apiClient.post('/reports', { targetType, targetID, reason, customReason, details }, { token });
}
