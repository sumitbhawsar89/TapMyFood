-- phone_otps: store OTP codes for WhatsApp verification
-- One row per OTP attempt. Verified=true = phone is trusted.
CREATE TABLE IF NOT EXISTS phone_otps (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone      VARCHAR(20) NOT NULL,
  otp        VARCHAR(6)  NOT NULL,
  token      VARCHAR(100) NOT NULL,
  verified   BOOLEAN DEFAULT false,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_phone_otps_phone ON phone_otps(phone);
CREATE INDEX IF NOT EXISTS idx_phone_otps_token ON phone_otps(token);

-- Auto-cleanup old OTPs (keeps table small)
-- Run this manually or via cron:
-- DELETE FROM phone_otps WHERE created_at < NOW() - INTERVAL '24 hours';

