const EMAIL_TIMEOUT_MS = 15000;

function createDeliveryError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

async function sendWithResend({ apiKey, from, to, subject, text, html, purpose }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), EMAIL_TIMEOUT_MS);

    try {
        const response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ from, to, subject, text, html }),
            signal: controller.signal
        });

        let result = {};
        try {
            result = await response.json();
        } catch {
            result = {};
        }

        if (!response.ok) {
            const reason = typeof result.message === 'string' ? result.message : `HTTP ${response.status}`;
            throw createDeliveryError(`Resend rejected the email request: ${reason}`, 'EMAIL_PROVIDER_REJECTED');
        }
        if (typeof result.id !== 'string' || !result.id) {
            throw createDeliveryError('Resend accepted the request without returning a message ID.', 'EMAIL_PROVIDER_INVALID_RESPONSE');
        }

        console.info(`[Verification email] Resend accepted ${purpose} email; messageId=${result.id}. Check Resend delivery logs for recipient status.`);
        return result.id;
    } catch (error) {
        if (error.name === 'AbortError') {
            throw createDeliveryError('Resend email request timed out.', 'EMAIL_PROVIDER_TIMEOUT');
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

async function sendWithSmtp({ smtpHost, smtpUser, smtpPass, from, to, subject, text, html, purpose }) {
    if (!smtpHost || !smtpUser || !smtpPass) {
        throw createDeliveryError('SMTP email delivery is not configured.', 'EMAIL_NOT_CONFIGURED');
    }

    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: Number(process.env.SMTP_PORT || 587),
        secure: String(process.env.SMTP_SECURE || 'false') === 'true',
        auth: { user: smtpUser, pass: smtpPass }
    });
    const delivery = await transporter.sendMail({ from, to, subject, text, html });
    const acceptedRecipients = Array.isArray(delivery.accepted) ? delivery.accepted : [];
    const recipientAccepted = acceptedRecipients.some(
        (recipient) => String(recipient).trim().toLowerCase() === to.toLowerCase()
    );
    if (!recipientAccepted) {
        throw createDeliveryError('The SMTP server did not accept the verification recipient.', 'EMAIL_RECIPIENT_REJECTED');
    }

    console.info(`[Verification email] SMTP accepted ${purpose} email for delivery; mailbox delivery is not confirmed.`);
    return delivery.messageId;
}

async function sendVerificationEmail(email, code, purpose) {
    const provider = String(process.env.EMAIL_PROVIDER || 'smtp').trim().toLowerCase();
    const smtpUser = process.env.SMTP_USER;
    const isSignup = purpose === 'signup';
    const subject = isSignup
        ? 'Enyukado | Student account email verification'
        : 'Enyukado | Password reset verification code';
    const heading = isSignup ? 'Verify your email address' : 'Password reset request';
    const introduction = isSignup
        ? 'We received a request to register an Enyukado account using this email address. To verify your email and continue registration, enter the code below on the Enyukado sign-up page.'
        : 'We received a request to reset the password for the Enyukado account associated with this email address. To continue, enter the code below on the password reset page.';
    const plainText = [
        'Dear student,',
        '',
        introduction,
        '',
        `VERIFICATION CODE: ${code}`,
        '',
        'This code is valid for 10 minutes. For your security, do not share it with anyone. Enyukado staff will never ask you to provide this code.',
        '',
        isSignup
            ? "If you did not request an Enyukado account, no action is needed. The account will not be created unless this email address is verified and registration is completed."
            : "If you did not request a password reset, no action is needed. Your password will remain unchanged.",
        '',
        'Regards,',
        'Enyukado Student Marketplace Support',
        '',
        'This is an automated message. Replies to this email are not monitored.'
    ].join('\n');
    const html = `
        <div style="margin:0;padding:32px 16px;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;color:#1f2937">
          <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
            <div style="padding:22px 28px;background:#173f6b;color:#ffffff">
              <div style="font-size:21px;font-weight:700;letter-spacing:.2px">Enyukado</div>
              <div style="margin-top:5px;font-size:13px;color:#dbeafe">Your campus marketplace</div>
            </div>
            <div style="padding:28px">
              <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#1f2937">Dear student,</p>
              <h1 style="margin:0 0 14px;font-size:21px;line-height:1.35;color:#173f6b">${heading}</h1>
              <p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:#4b5563">${introduction}</p>
              <div style="padding:18px;text-align:center;background:#fff9e8;border:1px solid #f0d27a;border-radius:8px">
                <div style="margin-bottom:8px;font-size:12px;font-weight:700;letter-spacing:1.2px;color:#72540b">YOUR VERIFICATION CODE</div>
                <div style="font-size:32px;font-weight:700;letter-spacing:8px;color:#173f6b">${code}</div>
              </div>
              <p style="margin:18px 0 0;font-size:14px;line-height:1.6;color:#4b5563">This code is valid for <strong>10 minutes</strong>. For your security, do not share it with anyone. Enyukado staff will never ask you to provide this code.</p>
              <p style="margin:18px 0 0;padding-top:18px;border-top:1px solid #e5e7eb;font-size:13px;line-height:1.6;color:#6b7280">${isSignup
                ? "If you did not request an Enyukado account, no action is needed. The account will not be created unless this email address is verified and registration is completed."
                : "If you did not request a password reset, no action is needed. Your password will remain unchanged."}</p>
              <p style="margin:20px 0 0;font-size:14px;line-height:1.6;color:#4b5563">Regards,<br /><strong>Enyukado Student Marketplace Support</strong></p>
            </div>
            <div style="padding:14px 28px;background:#f9fafb;font-size:12px;color:#6b7280">This is an automated Enyukado message. Replies are not monitored.</div>
          </div>
        </div>
    `;

    if (provider === 'resend') {
        const apiKey = process.env.RESEND_API_KEY;
        const from = process.env.EMAIL_FROM;
        if (!apiKey || !from) {
            throw createDeliveryError('Resend delivery requires RESEND_API_KEY and EMAIL_FROM.', 'EMAIL_NOT_CONFIGURED');
        }
        return sendWithResend({ apiKey, from, to: email, subject, text: plainText, html, purpose });
    }

    if (provider === 'smtp') {
        const from = process.env.SMTP_FROM || (smtpUser ? `Enyukado <${smtpUser}>` : '');
        return sendWithSmtp({
            smtpHost: process.env.SMTP_HOST,
            smtpUser,
            smtpPass: process.env.SMTP_PASS,
            from,
            to: email,
            subject,
            text: plainText,
            html,
            purpose
        });
    }

    throw createDeliveryError(`Unsupported EMAIL_PROVIDER "${provider}".`, 'EMAIL_PROVIDER_UNSUPPORTED');
}

module.exports = { sendVerificationEmail };
