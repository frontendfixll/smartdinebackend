import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { OtpModel, OtpPurpose, OtpChannel } from './otp.model';
import { config } from '@config/index';
import { AppError } from '@utils/AppError';
import { sendSms } from '@providers/sms.provider';
import { logger } from '@utils/logger';

function generateNumericCode(length: number): string {
  const max = 10 ** length;
  const n = crypto.randomInt(0, max);
  return n.toString().padStart(length, '0');
}

export interface IssueOtpInput {
  identifier: string;
  channel: OtpChannel;
  purpose: OtpPurpose;
  metadata?: Record<string, unknown>;
}

export async function issueOtp({ identifier, channel, purpose, metadata }: IssueOtpInput) {
  await OtpModel.updateMany(
    { identifier, purpose, consumedAt: { $exists: false } },
    { $set: { consumedAt: new Date(), 'metadata.invalidated': true } },
  );

  const code = generateNumericCode(config.otp.length);
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + config.otp.expiresInMin * 60_000);

  await OtpModel.create({
    identifier,
    channel,
    purpose,
    codeHash,
    expiresAt,
    attempts: 0,
    maxAttempts: config.otp.maxAttempts,
    metadata,
  });

  const body = `Your SmartDine verification code is ${code}. Valid for ${config.otp.expiresInMin} minutes.`;

  if (channel === 'sms') {
    const result = await sendSms({ to: identifier, body });
    if (result.mocked) logger.info(`[DEV OTP] ${identifier} → ${code}`);
  }

  return { expiresAt, mocked: !config.twilio.enabled };
}

export interface VerifyOtpInput {
  identifier: string;
  purpose: OtpPurpose;
  code: string;
}

export async function verifyOtp({ identifier, purpose, code }: VerifyOtpInput): Promise<void> {
  // Atomically increment attempts only when the OTP is still valid and within retry limit.
  // This prevents parallel requests from both passing the maxAttempts check before either saves.
  const otp = await OtpModel.findOneAndUpdate(
    {
      identifier,
      purpose,
      consumedAt: { $exists: false },
      expiresAt: { $gt: new Date() },
      $expr: { $lt: ['$attempts', '$maxAttempts'] },
    },
    { $inc: { attempts: 1 } },
    { new: true, sort: { createdAt: -1 } },
  );

  if (!otp) {
    // Provide a specific error by checking what exists without atomically mutating it
    const existing = await OtpModel.findOne({ identifier, purpose, consumedAt: { $exists: false } })
      .sort({ createdAt: -1 })
      .lean();
    if (!existing) throw AppError.unauthorized('No active OTP. Request a new one.');
    if (existing.expiresAt.getTime() < Date.now()) throw AppError.unauthorized('OTP expired. Request a new one.');
    throw AppError.unauthorized('Too many attempts. Request a new OTP.');
  }

  const ok = await bcrypt.compare(code, otp.codeHash);
  if (!ok) throw AppError.unauthorized('Invalid OTP code.');

  otp.consumedAt = new Date();
  await otp.save();
}
