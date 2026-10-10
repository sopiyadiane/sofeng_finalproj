import { apiClient } from './client.js';

// Admin session is stored separately from the student session (userToken),
// so logging in as admin never overwrites a student login in the same browser.
const KEY = 'adminSession';
export const getAdminSession = () => {
  try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; }
};
export const setAdminSession = (s) => localStorage.setItem(KEY, JSON.stringify(s));
export const clearAdminSession = () => localStorage.removeItem(KEY);

const auth = () => ({ token: getAdminSession()?.token });

export const adminLogin = (email, password) =>
  apiClient.post('/users/admin-login', { email, password });

// kind: 'accounts' | 'listings' | 'payments'
export const getCounts = () => apiClient.get('/admin/counts', auth());
export const getPending = (kind) => apiClient.get(`/admin/${kind}/pending`, auth());
export const getAllAccounts = () => apiClient.get('/admin/accounts/all', auth());
export const getAccountDetails = (id) => apiClient.get(`/admin/accounts/${id}/details`, auth());
export const enableAccount = (id) => apiClient.patch(`/admin/accounts/${id}/enable`, undefined, auth());
export const getOpenReports = () => apiClient.get('/admin/reports/open', auth());
export const getReportStats = () => apiClient.get('/admin/reports/stats', auth());
export const updateReportStatus = (id, status) => apiClient.patch(`/admin/reports/${id}/status`, { status }, auth());
export const deleteAccount = (id) => apiClient.del(`/admin/accounts/${id}`, auth());
export const getAllListings = () => apiClient.get('/admin/listings/all', auth());
export const deleteListing = (id) => apiClient.del(`/admin/listings/${id}`, auth());
export const approve = (kind, id) => apiClient.patch(`/admin/${kind}/${id}/approve`, undefined, auth());
export const reject = (kind, id, reason) => apiClient.patch(`/admin/${kind}/${id}/reject`, { reason }, auth());
