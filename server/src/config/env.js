import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load variables
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const envSchema = z.object({
  PORT: z.string().transform(Number).default('5000'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  CLIENT_URL: z.string().url('CLIENT_URL must be a valid URL'),
  SMTP_HOST: z.string().default('smtp.mailtrap.io'),
  SMTP_PORT: z.string().transform(Number).default('2525'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().email('SMTP_FROM must be a valid email').default('noreply@leadsbase.io'),
  MAX_CSV_FILE_SIZE_MB: z.string().transform(Number).default('4.5'),
  PGHOST: z.string().min(1, 'PGHOST is required'),
  PGPORT: z.string().transform(Number).default('5432'),
  PGUSER: z.string().default('postgres'),
  PGPASSWORD: z.string().min(1, 'PGPASSWORD is required'),
  PGDATABASE: z.string().default('postgres'),
  PGSSL: z.string().default('true'),
  USE_RDS_IAM: z.string().default('false'),
  AWS_REGION: z.string().default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_SESSION_TOKEN: z.string().optional(),
  SQS_IMPORT_QUEUE_URL: z.string().url().optional(),
  S3_BUCKET: z.string().optional(),
  SES_FROM_EMAIL: z.string().email().optional(),
});

let env;
try {
  env = envSchema.parse(process.env);
} catch (error) {
  console.error('❌ Invalid Environment Configuration:');
  if (error instanceof z.ZodError) {
    error.errors.forEach((err) => {
      console.error(`  - ${err.path.join('.')}: ${err.message}`);
    });
  } else {
    console.error(error);
  }
  process.exit(1);
}

export default env;
export const {
  PORT,
  NODE_ENV,
  JWT_ACCESS_SECRET,
  JWT_REFRESH_SECRET,
  CLIENT_URL,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  SMTP_FROM,
  MAX_CSV_FILE_SIZE_MB,
  PGHOST,
  PGPORT,
  PGUSER,
  PGPASSWORD,
  PGDATABASE,
  PGSSL,
  USE_RDS_IAM,
  AWS_REGION,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  AWS_SESSION_TOKEN,
  SQS_IMPORT_QUEUE_URL,
  SES_FROM_EMAIL,
} = env;
