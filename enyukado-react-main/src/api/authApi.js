import { apiClient } from './client.js';

export function login({ email, password }) {
  return apiClient.post('/users/login', { email, password });
}

export function register({ firstName, lastName, email, password }) {
  return apiClient.post('/users/register', { firstName, lastName, email, password });
}

export function requestSignupVerificationCode({ email }) {
  return apiClient.post('/users/send-signup-code', { email });
}

export function verifySignupVerificationCode({ email, code }) {
  return apiClient.post('/users/verify-signup-code', { email, code });
}

export function requestPasswordResetCode({ identifier }) {
  return apiClient.post('/users/forgot-password', { identifier });
}

export function verifyPasswordResetCode({ identifier, code }) {
  return apiClient.post('/users/verify-reset-code', { identifier, code });
}

export function resetPassword({ identifier, code, newPassword }) {
  return apiClient.put('/users/reset-password', { identifier, code, newPassword });
}
