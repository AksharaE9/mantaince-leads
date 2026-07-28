import pg from 'pg';
import AWS from 'aws-sdk';
import {
    PGHOST,
    PGPORT,
    PGUSER,
    PGPASSWORD,
    PGDATABASE,
    USE_RDS_IAM,
    AWS_REGION
} from './env.js';

const { Pool } = pg;

// ── IAM Token Cache ───────────────────────────────────────────────────────────
let cachedToken = null;
let tokenExpiry = 0;

async function getAuthToken() {
    if (USE_RDS_IAM !== 'true') {
        return PGPASSWORD;
    }
    // Reuse token if still valid (IAM tokens last 15min; refresh at 10min)
    if (cachedToken && Date.now() < tokenExpiry) {
        return cachedToken;
    }
    const signer = new AWS.RDS.Signer({
        region: AWS_REGION || 'eu-north-1',
        hostname: PGHOST,
        port: parseInt(PGPORT || '5432', 10),
        username: PGUSER || 'postgres'
    });
    console.log('🔄 Generating new RDS IAM Token...');
    cachedToken = signer.getAuthToken({});
    tokenExpiry = Date.now() + 600_000; // 10 minutes
    return cachedToken;
}

// ── Connection Pool ───────────────────────────────────────────────────────────
const pool = new Pool({
    host:     PGHOST,
    port:     parseInt(PGPORT || '5432', 10),
    user:     PGUSER || 'postgres',
    database: PGDATABASE || 'postgres',
    password: getAuthToken,          // Dynamic resolver — fetches IAM token on demand
    // SSL configuration for Neon Postgres (pooler endpoint).
    //
    // Problem: Vercel's Node.js runtime ships a stripped CA bundle that omits
    // the ISRG Root X1 intermediate used by Neon's *.c-2.ap-southeast-1.aws.neon.tech
    // pooler endpoint. This causes "self signed certificate in certificate chain"
    // errors — the TLS handshake succeeds (the connection is encrypted) but
    // Node rejects the server cert because it can't build the chain to a trusted root.
    //
    // Fix: embed ISRG Root X1 (Let's Encrypt's root CA, SHA-256 fingerprint verified
    // at https://letsencrypt.org/certificates/) explicitly so the chain resolves in
    // both local Node.js (already has it) and Vercel's sandbox (may not have it).
    // This does NOT reduce security — it is the same well-known public root CA.
    ssl: process.env.PGSSL === 'false' ? false : {
        rejectUnauthorized: true,
        ca: `-----BEGIN CERTIFICATE-----
MIIFazCCA1OgAwIBAgIRAIIQz7DSQONZRGPgu2OCiwAwDQYJKoZIhvcNAQELBQAw
TzELMAkGA1UEBhMCVVMxKTAnBgNVBAoTIEludGVybmV0IFNlY3VyaXR5IFJlc2Vh
cmNoIEdyb3VwMRUwEwYDVQQDEwxJU1JHIFJvb3QgWDEwHhcNMTUwNjA0MTEwNDM4
WhcNMzUwNjA0MTEwNDM4WjBPMQswCQYDVQQGEwJVUzEpMCcGA1UEChMgSW50ZXJu
ZXQgU2VjdXJpdHkgUmVzZWFyY2ggR3JvdXAxFTATBgNVBAMTDElTUkcgUm9vdCBY
MTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAK3oJHP0FDfzm54rVygc
h77ct984kIxuPOZXoHj3dcKi/vVqbvYATyjb3miGbESTtrFj/RQSa78f0uoxmyF+
0TM8ukj13Xnfs7j/EvEhmkvBioZxaUpmZmyPfjxwv60pIgbz5MDmgK7iS4+3mX6U
A5/TR5d8mUgjU+g4rk8Kb4Mu0UlXjIB0ttov0DiNewNwIRt18jA8+o+u3dpjq+sW
T8KOEUt+zwvo/7V3LvSye0rgTBIlDHCNAymg4VMk7BPZ7hm/ELNKjD+Jo2FR3qyH
B5T0Y3HsLuJvW5iB4YlcNHlsdu87kGJ55tukmi8mxdAQ4Q7e2RCOFvu396j3x+UC
B5iPNgiV5+I3lg02dZ77DnKxHZu8A/lJBdiB3QW0KtZB6awBdpUKD9jf1b0SHzUv
KBds0pjBqAlkd25HN7rOrFleaJ1/ctaJxQZBKT5ZPt0m9STJEadao0xAH0ahmbWn
OlFuhjuefXKnEgV4We0+UXgVCwOPjdAvBbI+e0ocS3MFEvzG6uBQE3xDk3SzynTn
jh8BCNAw1FtxNrQHusEwMFxIt4I7mKZ9YIqioymCzLq9gwQbooMDQaHWBfEbwrbw
qHyGO0aoSCqI3Haadr8faqU9GY/rOPNk3sgrDQoo//fb4hVC1CLQJ13hef4Y53CI
rU7m2Ys6xt0nUW7/vGT1M0NPAgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNV
HRMBAf8EBTADAQH/MB0GA1UdDgQWBBR5tFnme7bl5AFzgAiIyBpY9umbbjANBgkq
hkiG9w0BAQsFAAOCAgEAVR9YqbyyqFDQDLHYGmkgJykIrGF1XIpu+ILlaS/V9lZL
ubhzEFnTIZd+50xx+7LSYK05qAvqFyFWhfFQDlnrzuBZ6brJFe+GnY+EgPbk6ZGQ
3BebYhtF8GaV0nxvwuo77x/Py9auJ/GpsMiu/X1+mvoiBOv/2X/qkSsisRcOj/KK
NFtY2PwByVS5uCbMiogziUwthDyC3+6WVwW6LLv3xLfHTjuCvjHIInNzktHCgKQ5
ORAzI4JMPJ+GslWYHb4phowim57iaztXOoJwTdwJx4nLCgdNbOhdjsnvzqvHu7Ur
TkXWStAmzOVyyghqpZXjFaH3pO3JLF+l+/+sKAIuvtd7u+Nxe5AW0wdeRlN8NwdC
jNPElpzVmbUq4JUagEiuTDkHzsxHpFKVK7q4+63SM1N95R1NbdWhscdCb+ZAJzVc
oyi3B43njTOQ5yOf+1CceWxG1bQVs5ZufpsMljq4Ui0/1lvh+wjChP4kqKOJ2qxq
4RgqsahDYVvTH9w7jXbyLeiNdd8XM2w9U/t7y0Ff/9yi0GE44Za4rF2LN9d11TPA
mRGunUHBcnWEvgJBQl9nJEiU0Zsnvgc/ubhPgXRR4Xq37Z0j4r7g1SgEEzwxA57d
emyPxgcYxn/eR44/KJ4EBs+lVDR3veyJm+kXQ99b21/+jh5Xos1AnX5iItreGCc=
-----END CERTIFICATE-----`
    },
    // Pool settings for Vercel's fan-out serverless model: each concurrent
    // instance gets its own independent pool, and Neon's `-pooler` endpoint
    // (PgBouncer) is already doing the real cross-instance multiplexing —
    // this pool only needs to serve one instance's own limited concurrency.
    max:                     5,      // Small per-instance cap; upstream pooler handles fan-out
    min:                      5,     // NOTE: pg-pool's `min` does not eagerly open connections at
                                      // startup — it only prevents pruning below this count once
                                      // connections have been opened by activity.
    idleTimeoutMillis:      20_000,  // Reclaim idle connections faster (20 s)
    connectionTimeoutMillis: 5_000,
    allowExitOnIdle:        false,
    keepAlive:              true,    // Prevent TCP RST from Aurora idle timeout (8h default)
    keepAliveInitialDelayMillis: 10_000,
    statement_timeout:      15000,   // 15s hard limit — more headroom for CSV exports
});

// Surface idle-client errors before they cause silent failures
pool.on('error', (err) => {
    console.error('❌ Idle pool client error:', err.message);
});

import { timingContext } from '../middleware/timing.js';

export const query = async (text, params) => {
    const req = timingContext.getStore();
    if (req?.timer) req.timer.start('db');
    try {
        return await pool.query(text, params);
    } finally {
        if (req?.timer) req.timer.end('db');
    }
};

// ── Database Initialization ───────────────────────────────────────────────────
export const connectDB = async () => {
    try {
        console.log(`📡 Attempting to connect to RDS: ${PGHOST}:${PGPORT} as ${PGUSER}`);
        const client = await pool.connect();
        console.log(`✅ RDS Connected: ${PGHOST}`);
        client.release();
        await runMigrations();
    } catch (err) {
        console.error('❌ RDS Connection Error:', err.message);
        if (!process.env.VERCEL) {
            process.exit(1);
        } else {
            throw err;
        }
    }
};

const checkSchemaReady = async () => {
    try {
        const res = await pool.query(`
            SELECT EXISTS (
                SELECT 1 FROM information_schema.columns 
                WHERE table_name = 'cost_conversions' AND column_name = 'stage_id'
            ) AND EXISTS (
                SELECT 1 FROM information_schema.columns 
                WHERE table_name = 'sessions' AND column_name = 'token_hash'
            ) AND EXISTS (
                SELECT 1 FROM information_schema.columns 
                WHERE table_name = 'csv_upload_logs' AND column_name = 'lead_type'
            ) AND EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'users' AND column_name = 'is_approved'
            ) AND EXISTS (
                SELECT 1 FROM information_schema.tables
                WHERE table_name = 'raw_data'
            ) AND EXISTS (
                SELECT 1 FROM information_schema.tables
                WHERE table_name = 'delivery_data'
            ) AS ready;
        `);
        return res.rows[0]?.ready || false;
    } catch (err) {
        console.log('⚠️ Schema check failed, running migrations anyway:', err.message);
        return false;
    }
};

// ── Migrations ────────────────────────────────────────────────────────────────
// Split into 4 phases so a transient error in phase 2/3 never blocks phase 1.
const runMigrations = async () => {
    const isReady = await checkSchemaReady();
    if (isReady && process.env.FORCE_MIGRATIONS !== 'true') {
        console.log('🏗️ Database schema is already up-to-date. Skipping core migrations.');
        return;
    }
    console.log('🏗️ Running database migrations...');

    // ── Phase 1: Core Schema ─────────────────────────────────────────────────
    const coreDdl = `
        CREATE TABLE IF NOT EXISTS roles (
            id UUID PRIMARY KEY,
            name VARCHAR(50) UNIQUE NOT NULL,
            permissions TEXT[] DEFAULT '{}',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS users (
            id UUID PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            email VARCHAR(255) UNIQUE NOT NULL,
            password_hash VARCHAR(255) NOT NULL,
            role_id UUID NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
            vertical_access UUID[] DEFAULT '{}',
            is_active BOOLEAN DEFAULT TRUE,
            is_approved BOOLEAN DEFAULT FALSE,
            last_login_at TIMESTAMP,
            invite_token VARCHAR(255),
            invite_token_expiry TIMESTAMP,
            created_by UUID,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS verticals (
            id UUID PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            slug VARCHAR(255) UNIQUE NOT NULL,
            description TEXT,
            color VARCHAR(50) DEFAULT '#185FA5',
            icon VARCHAR(50) DEFAULT 'Layers',
            display_order INTEGER DEFAULT 0,
            is_active BOOLEAN DEFAULT TRUE,
            created_by UUID REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS sub_verticals (
            id UUID PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            slug VARCHAR(255) NOT NULL,
            vertical_id UUID NOT NULL REFERENCES verticals(id) ON DELETE CASCADE,
            display_order INTEGER DEFAULT 0,
            is_active BOOLEAN DEFAULT TRUE,
            created_by UUID REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT unique_vertical_slug UNIQUE (vertical_id, slug)
        );

        CREATE TABLE IF NOT EXISTS cost_conversion_stages (
            id UUID PRIMARY KEY,
            sub_vertical_id UUID NOT NULL REFERENCES sub_verticals(id) ON DELETE CASCADE,
            name VARCHAR(255) NOT NULL,
            display_order INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS field_configs (
            id UUID PRIMARY KEY,
            vertical_id UUID NOT NULL REFERENCES verticals(id) ON DELETE CASCADE,
            field_key VARCHAR(255) NOT NULL,
            label VARCHAR(255) NOT NULL,
            field_type VARCHAR(50) NOT NULL,
            options TEXT[] DEFAULT '{}',
            is_required BOOLEAN DEFAULT FALSE,
            is_csv_mapped BOOLEAN DEFAULT FALSE,
            csv_header VARCHAR(255),
            display_order INTEGER DEFAULT 0,
            is_visible BOOLEAN DEFAULT TRUE,
            is_active BOOLEAN DEFAULT TRUE,
            is_table_column BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT unique_vertical_field_key UNIQUE (vertical_id, field_key)
        );

        CREATE TABLE IF NOT EXISTS csv_upload_logs (
            id UUID PRIMARY KEY,
            uploaded_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            vertical_id UUID NOT NULL REFERENCES verticals(id) ON DELETE CASCADE,
            sub_vertical_id UUID REFERENCES sub_verticals(id) ON DELETE CASCADE,
            assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
            file_name VARCHAR(255),
            original_file_name VARCHAR(255),
            total_rows INTEGER DEFAULT 0,
            success_count INTEGER DEFAULT 0,
            failed_count INTEGER DEFAULT 0,
            duplicate_count INTEGER DEFAULT 0,
            errors JSONB DEFAULT '[]',
            status VARCHAR(50) DEFAULT 'processing',
            processing_started_at TIMESTAMP,
            processing_finished_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS cost_conversions (
            id UUID PRIMARY KEY,
            vertical_id UUID NOT NULL REFERENCES verticals(id) ON DELETE CASCADE,
            sub_vertical_id UUID REFERENCES sub_verticals(id) ON DELETE SET NULL,
            assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
            uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
            name VARCHAR(255) NOT NULL,
            phone VARCHAR(50),
            business_name VARCHAR(255),
            data JSONB DEFAULT '{}',
            status VARCHAR(50) DEFAULT 'new',
            source VARCHAR(50) DEFAULT 'manual',
            csv_batch_id UUID REFERENCES csv_upload_logs(id) ON DELETE SET NULL,
            is_deleted BOOLEAN DEFAULT FALSE,
            deleted_at TIMESTAMP,
            deleted_by UUID REFERENCES users(id) ON DELETE SET NULL,
            search_vector TSVECTOR,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            stage_id UUID REFERENCES cost_conversion_stages(id) ON DELETE SET NULL,
            lead_type VARCHAR(50) NOT NULL DEFAULT 'CALL',
            geotag_lat DOUBLE PRECISION,
            geotag_lng DOUBLE PRECISION,
            geotag_accuracy DOUBLE PRECISION,
            geotag_photo_key TEXT,
            geotag_address TEXT,
            geotag_captured_at TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS user_assignments (
            id UUID PRIMARY KEY,
            user_id UUID REFERENCES users(id) ON DELETE CASCADE,
            sub_vertical_id UUID REFERENCES sub_verticals(id) ON DELETE CASCADE,
            assigned_by UUID REFERENCES users(id) ON DELETE SET NULL,
            is_active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, sub_vertical_id)
        );

        CREATE TABLE IF NOT EXISTS custom_fields (
            id VARCHAR(50) PRIMARY KEY,
            sub_vertical_id UUID NOT NULL REFERENCES sub_verticals(id) ON DELETE CASCADE,
            label VARCHAR(255) NOT NULL,
            field_key VARCHAR(255) NOT NULL,
            field_type VARCHAR(50) DEFAULT 'TEXT',
            is_required BOOLEAN DEFAULT FALSE,
            placeholder VARCHAR(255),
            options TEXT[] DEFAULT '{}',
            "order" INTEGER DEFAULT 0,
            is_active BOOLEAN DEFAULT TRUE,
            is_deleted BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT unique_sub_vertical_field_key UNIQUE (sub_vertical_id, field_key)
        );

        CREATE TABLE IF NOT EXISTS cost_conversion_custom_values (
            id VARCHAR(50) PRIMARY KEY,
            cost_conversion_id UUID NOT NULL REFERENCES cost_conversions(id) ON DELETE CASCADE,
            custom_field_id VARCHAR(50) REFERENCES custom_fields(id) ON DELETE CASCADE,
            value TEXT NOT NULL,
            CONSTRAINT unique_cost_conversion_custom_field UNIQUE (cost_conversion_id, custom_field_id)
        );

        CREATE TABLE IF NOT EXISTS follow_ups (
            id VARCHAR(50) PRIMARY KEY,
            cost_conversion_id UUID NOT NULL REFERENCES cost_conversions(id) ON DELETE CASCADE,
            sub_vertical_id UUID NOT NULL REFERENCES sub_verticals(id) ON DELETE CASCADE,
            assigned_to_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
            created_by_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
            follow_up_date TIMESTAMP NOT NULL,
            description TEXT NOT NULL,
            status VARCHAR(50) DEFAULT 'PENDING',
            completed_at TIMESTAMP,
            completed_note TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS sessions (
            id UUID PRIMARY KEY,
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            token_hash VARCHAR(255) UNIQUE NOT NULL,
            expires_at TIMESTAMP NOT NULL,
            ip VARCHAR(50),
            user_agent TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS escalations (
            id VARCHAR(50) PRIMARY KEY,
            cost_conversion_id UUID NOT NULL REFERENCES cost_conversions(id) ON DELETE CASCADE,
            escalated_by_id UUID NOT NULL REFERENCES users(id),
            escalated_to_id UUID NOT NULL REFERENCES users(id),
            reason TEXT NOT NULL,
            status VARCHAR(50) DEFAULT 'OPEN',
            resolution_note TEXT,
            resolved_by_id UUID REFERENCES users(id),
            resolved_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS rate_limit_counters (
            bucket_key VARCHAR(255) PRIMARY KEY,
            count INTEGER NOT NULL DEFAULT 1,
            expires_at TIMESTAMP NOT NULL
        );

        DO $$
        BEGIN
            -- Check if audit_logs table exists and is NOT partitioned
            IF EXISTS (
                SELECT 1 FROM information_schema.tables 
                WHERE table_name = 'audit_logs'
            ) AND NOT EXISTS (
                SELECT 1 FROM pg_partitioned_table p
                JOIN pg_class c ON p.partrelid = c.oid
                WHERE c.relname = 'audit_logs'
            ) THEN
                -- Rename existing table
                ALTER TABLE audit_logs RENAME TO audit_logs_old;
                
                -- Create partitioned table
                CREATE TABLE audit_logs (
                    id UUID NOT NULL,
                    actor_id UUID REFERENCES users(id) ON DELETE CASCADE,
                    action VARCHAR(255) NOT NULL,
                    target_collection VARCHAR(255) NOT NULL,
                    target_id UUID,
                    diff JSONB,
                    ip VARCHAR(50),
                    execution_time_ms INTEGER,
                    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (id, created_at)
                ) PARTITION BY RANGE (created_at);
                
                -- Create default partition
                CREATE TABLE audit_logs_default PARTITION OF audit_logs DEFAULT;
                
                -- Create specific partitions for 2026
                CREATE TABLE IF NOT EXISTS audit_logs_y2026m06 PARTITION OF audit_logs
                    FOR VALUES FROM ('2026-06-01 00:00:00') TO ('2026-07-01 00:00:00');
                CREATE TABLE IF NOT EXISTS audit_logs_y2026m07 PARTITION OF audit_logs
                    FOR VALUES FROM ('2026-07-01 00:00:00') TO ('2026-08-01 00:00:00');
                CREATE TABLE IF NOT EXISTS audit_logs_y2026m08 PARTITION OF audit_logs
                    FOR VALUES FROM ('2026-08-01 00:00:00') TO ('2026-09-01 00:00:00');
                    
                -- Copy data from old table to new partitioned table
                INSERT INTO audit_logs (id, actor_id, action, target_collection, target_id, diff, ip, execution_time_ms, created_at)
                SELECT id, actor_id, action, target_collection, target_id, diff, ip, execution_time_ms, created_at
                FROM audit_logs_old;
                
                -- Drop old table
                DROP TABLE audit_logs_old;
            ELSIF NOT EXISTS (
                SELECT 1 FROM information_schema.tables 
                WHERE table_name = 'audit_logs'
            ) THEN
                -- Create partitioned table directly if it doesn't exist
                CREATE TABLE audit_logs (
                    id UUID NOT NULL,
                    actor_id UUID REFERENCES users(id) ON DELETE CASCADE,
                    action VARCHAR(255) NOT NULL,
                    target_collection VARCHAR(255) NOT NULL,
                    target_id UUID,
                    diff JSONB,
                    ip VARCHAR(50),
                    execution_time_ms INTEGER,
                    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (id, created_at)
                ) PARTITION BY RANGE (created_at);
                
                -- Create default partition
                CREATE TABLE audit_logs_default PARTITION OF audit_logs DEFAULT;
                
                -- Create specific partitions for 2026
                CREATE TABLE IF NOT EXISTS audit_logs_y2026m06 PARTITION OF audit_logs
                    FOR VALUES FROM ('2026-06-01 00:00:00') TO ('2026-07-01 00:00:00');
                CREATE TABLE IF NOT EXISTS audit_logs_y2026m07 PARTITION OF audit_logs
                    FOR VALUES FROM ('2026-07-01 00:00:00') TO ('2026-08-01 00:00:00');
                CREATE TABLE IF NOT EXISTS audit_logs_y2026m08 PARTITION OF audit_logs
                    FOR VALUES FROM ('2026-08-01 00:00:00') TO ('2026-09-01 00:00:00');
            END IF;
        END $$;

        -- Ensure additive columns exist (idempotent)
        ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_token VARCHAR(255);
        ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_token_expiry TIMESTAMP;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS vertical_access UUID[] DEFAULT '{}';
        
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns 
                WHERE table_name = 'users' AND column_name = 'is_approved'
            ) THEN
                ALTER TABLE users ADD COLUMN is_approved BOOLEAN DEFAULT TRUE;
                ALTER TABLE users ALTER COLUMN is_approved SET DEFAULT FALSE;
            END IF;
        END $$;

        ALTER TABLE sessions ADD COLUMN IF NOT EXISTS token_hash VARCHAR(255);
        ALTER TABLE sessions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;
        ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_agent TEXT;
        ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ip VARCHAR(50);
        
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM information_schema.columns 
                WHERE table_name = 'sessions' AND column_name = 'token'
            ) THEN
                ALTER TABLE sessions ALTER COLUMN token DROP NOT NULL;
            END IF;
        END $$;

        ALTER TABLE sessions ALTER COLUMN user_id SET NOT NULL;

        ALTER TABLE verticals ADD COLUMN IF NOT EXISTS color VARCHAR(50) DEFAULT '#185FA5';
        ALTER TABLE verticals ADD COLUMN IF NOT EXISTS icon VARCHAR(50) DEFAULT 'Layers';
        ALTER TABLE verticals ADD COLUMN IF NOT EXISTS display_order INTEGER DEFAULT 0;
        ALTER TABLE verticals ADD COLUMN IF NOT EXISTS statuses JSONB DEFAULT '[]';
        ALTER TABLE sub_verticals ADD COLUMN IF NOT EXISTS display_order INTEGER DEFAULT 0;
        ALTER TABLE cost_conversion_stages ADD COLUMN IF NOT EXISTS display_order INTEGER DEFAULT 0;

        ALTER TABLE field_configs ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
        ALTER TABLE field_configs ADD COLUMN IF NOT EXISTS is_table_column BOOLEAN DEFAULT TRUE;
        ALTER TABLE custom_fields ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;

        ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS execution_time_ms INTEGER;

        ALTER TABLE csv_upload_logs ADD COLUMN IF NOT EXISTS original_file_name VARCHAR(255);
        ALTER TABLE csv_upload_logs ADD COLUMN IF NOT EXISTS sub_vertical_id UUID REFERENCES sub_verticals(id) ON DELETE CASCADE;
        ALTER TABLE csv_upload_logs ADD COLUMN IF NOT EXISTS assigned_to UUID REFERENCES users(id) ON DELETE SET NULL;
        ALTER TABLE csv_upload_logs ADD COLUMN IF NOT EXISTS duplicate_count INTEGER DEFAULT 0;
        ALTER TABLE csv_upload_logs ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMP;
        ALTER TABLE csv_upload_logs ADD COLUMN IF NOT EXISTS processing_finished_at TIMESTAMP;
        ALTER TABLE csv_upload_logs ALTER COLUMN file_name DROP NOT NULL;
        ALTER TABLE csv_upload_logs ADD COLUMN IF NOT EXISTS lead_type VARCHAR(50) NOT NULL DEFAULT 'CALL';

        -- FTS column (idempotent)
        ALTER TABLE cost_conversions ADD COLUMN IF NOT EXISTS search_vector TSVECTOR;

        -- Additive columns for cost_conversions table
        ALTER TABLE cost_conversions ADD COLUMN IF NOT EXISTS lead_type VARCHAR(50) NOT NULL DEFAULT 'CALL';
        ALTER TABLE cost_conversions ADD COLUMN IF NOT EXISTS geotag_lat DOUBLE PRECISION;
        ALTER TABLE cost_conversions ADD COLUMN IF NOT EXISTS geotag_lng DOUBLE PRECISION;
        ALTER TABLE cost_conversions ADD COLUMN IF NOT EXISTS geotag_accuracy DOUBLE PRECISION;
        ALTER TABLE cost_conversions ADD COLUMN IF NOT EXISTS geotag_photo_key TEXT;
        ALTER TABLE cost_conversions ADD COLUMN IF NOT EXISTS geotag_address TEXT;
        ALTER TABLE cost_conversions ADD COLUMN IF NOT EXISTS geotag_captured_at TIMESTAMP;
        ALTER TABLE cost_conversions ADD COLUMN IF NOT EXISTS stage_id UUID REFERENCES cost_conversion_stages(id) ON DELETE SET NULL;

        -- Migrate user_assignments from vertical_id to sub_vertical_id if vertical_id column exists
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM information_schema.columns 
                WHERE table_name = 'user_assignments' AND column_name = 'vertical_id'
            ) THEN
                -- Drop the unique constraint first
                ALTER TABLE user_assignments DROP CONSTRAINT IF EXISTS user_assignments_user_id_vertical_id_key;
                
                -- Add new columns if they do not exist
                ALTER TABLE user_assignments ADD COLUMN IF NOT EXISTS sub_vertical_id UUID REFERENCES sub_verticals(id) ON DELETE CASCADE;
                ALTER TABLE user_assignments ADD COLUMN IF NOT EXISTS assigned_by UUID REFERENCES users(id) ON DELETE SET NULL;
                
                -- Drop column vertical_id
                ALTER TABLE user_assignments DROP COLUMN IF EXISTS vertical_id;
                
                -- Add new unique constraint
                ALTER TABLE user_assignments ADD CONSTRAINT user_assignments_user_id_sub_vertical_id_key UNIQUE (user_id, sub_vertical_id);
            END IF;
        END $$;

        -- Discriminates csv_upload_logs batches by target entity so the same
        -- upload/queue/worker plumbing serves both Leads and Raw Data.
        -- Existing rows are all lead imports, hence the 'lead' default.
        ALTER TABLE csv_upload_logs ADD COLUMN IF NOT EXISTS entity_type VARCHAR(20) NOT NULL DEFAULT 'lead';

        CREATE TABLE IF NOT EXISTS raw_data (
            id UUID PRIMARY KEY,
            vertical_id UUID NOT NULL REFERENCES verticals(id) ON DELETE CASCADE,
            assigned_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
            date DATE,
            business_type VARCHAR(255),
            business_name VARCHAR(255) NOT NULL,
            area VARCHAR(255),
            city VARCHAR(255),
            phone_number VARCHAR(50),
            address TEXT,
            appointment_date DATE,
            appointment_timings VARCHAR(100),
            remarks TEXT,
            source VARCHAR(20) NOT NULL DEFAULT 'single_add',
            csv_batch_id UUID REFERENCES csv_upload_logs(id) ON DELETE SET NULL,
            created_by UUID REFERENCES users(id) ON DELETE SET NULL,
            is_deleted BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_raw_data_vertical ON raw_data(vertical_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_raw_data_phone ON raw_data(vertical_id, phone_number);

        -- Delivery Data: fourth independent bulk-import feature, sibling of
        -- Raw Data (own table, own schema) — not merged into raw_data.
        -- linked_raw_data_id is a nullable, best-effort soft-link auto-set
        -- at write time by phone/business-name matching; standalone rows
        -- (no match) are equally valid, never required.
        CREATE TABLE IF NOT EXISTS delivery_data (
            id UUID PRIMARY KEY,
            vertical_id UUID NOT NULL REFERENCES verticals(id) ON DELETE CASCADE,
            assigned_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
            date DATE,
            business_type VARCHAR(255),
            business_name VARCHAR(255) NOT NULL,
            area VARCHAR(255),
            city VARCHAR(255),
            phone_number VARCHAR(50),
            address TEXT,
            appointment_date DATE,
            appointment_timings VARCHAR(100),
            remarks TEXT,
            delivery_date DATE NOT NULL,
            delivery_time VARCHAR(100) NOT NULL,
            linked_raw_data_id UUID REFERENCES raw_data(id) ON DELETE SET NULL,
            source VARCHAR(20) NOT NULL DEFAULT 'single_add',
            csv_batch_id UUID REFERENCES csv_upload_logs(id) ON DELETE SET NULL,
            created_by UUID REFERENCES users(id) ON DELETE SET NULL,
            is_deleted BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_delivery_data_vertical ON delivery_data(vertical_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_delivery_data_phone ON delivery_data(vertical_id, phone_number);
        CREATE INDEX IF NOT EXISTS idx_delivery_data_linked_raw_data ON delivery_data(linked_raw_data_id);
    `;

    // ── Phase 2: Performance Indexes ─────────────────────────────────────────
    const perfDdl = `
        CREATE EXTENSION IF NOT EXISTS pg_trgm;

        -- Trigram indexes: fast ILIKE fallback for short/partial searches
        CREATE INDEX IF NOT EXISTS idx_cost_conversions_name_trgm     ON cost_conversions USING gin (name gin_trgm_ops);
        CREATE INDEX IF NOT EXISTS idx_cost_conversions_phone_trgm    ON cost_conversions USING gin (phone gin_trgm_ops);
        CREATE INDEX IF NOT EXISTS idx_cost_conversions_biz_trgm      ON cost_conversions USING gin (business_name gin_trgm_ops);

        -- JSONB GIN index for data field queries
        CREATE INDEX IF NOT EXISTS idx_cost_conversions_data_gin ON cost_conversions USING gin (data);

        -- Foreign key indexes (critical for JOIN performance)
        CREATE INDEX IF NOT EXISTS idx_sub_verticals_vertical_id ON sub_verticals(vertical_id);
        CREATE INDEX IF NOT EXISTS idx_cost_conversions_vertical_id         ON cost_conversions(vertical_id);
        CREATE INDEX IF NOT EXISTS idx_cost_conversions_sub_vertical_id     ON cost_conversions(sub_vertical_id);
        CREATE INDEX IF NOT EXISTS idx_cost_conversions_assigned_to         ON cost_conversions(assigned_to);

        -- B-Tree indexes for exact matches & filtering
        CREATE INDEX IF NOT EXISTS idx_cost_conversions_vertical_phone_btree ON cost_conversions (vertical_id, phone);
        CREATE INDEX IF NOT EXISTS idx_cost_conversions_csv_batch_id ON cost_conversions (csv_batch_id);

        -- COVERING INDEX: satisfied entirely from the index — no heap fetch.
        DROP INDEX IF EXISTS idx_leads_list_covering;
        DROP INDEX IF EXISTS idx_cost_conversions_list_covering;
        CREATE INDEX IF NOT EXISTS idx_cost_conversions_list_covering
            ON cost_conversions (vertical_id, created_at DESC, id DESC)
            INCLUDE (name, phone, business_name, status, assigned_to, sub_vertical_id, updated_at)
            WHERE is_deleted = false;

        -- Report optimizations: Status, Area (expression), Agent performance, Conversion trend
        CREATE INDEX IF NOT EXISTS idx_cost_conversions_vertical_status_covering ON cost_conversions (vertical_id, status) WHERE is_deleted = false;
        CREATE INDEX IF NOT EXISTS idx_cost_conversions_vertical_area_expr ON cost_conversions (vertical_id, (data->>'area')) WHERE is_deleted = false;
        CREATE INDEX IF NOT EXISTS idx_cost_conversions_vertical_assigned ON cost_conversions (vertical_id, assigned_to) WHERE is_deleted = false;
        CREATE INDEX IF NOT EXISTS idx_cost_conversions_vertical_created_status ON cost_conversions (vertical_id, created_at, status) WHERE is_deleted = false;

        -- PARTIAL INDEX: "My Cost/Conversions" agent view — only assigned + open
        CREATE INDEX IF NOT EXISTS idx_cost_conversions_assigned_open
            ON cost_conversions (assigned_to, vertical_id, created_at DESC)
            WHERE is_deleted = false;

        -- BRIN INDEX: Date-range queries on created_at — 100× smaller than B-tree.
        CREATE INDEX IF NOT EXISTS idx_cost_conversions_created_brin ON cost_conversions USING BRIN (created_at);

        -- Performance sort & filter indexes for active items
        CREATE INDEX IF NOT EXISTS idx_cost_conversions_vertical_name ON cost_conversions (vertical_id, name) WHERE is_deleted = false;
        CREATE INDEX IF NOT EXISTS idx_cost_conversions_vertical_business_name ON cost_conversions (vertical_id, business_name) WHERE is_deleted = false;
        CREATE INDEX IF NOT EXISTS idx_cost_conversions_vertical_updated_at ON cost_conversions (vertical_id, updated_at DESC, id DESC) WHERE is_deleted = false;
        CREATE INDEX IF NOT EXISTS idx_cost_conversions_vertical_sub_vertical ON cost_conversions (vertical_id, sub_vertical_id) WHERE is_deleted = false;

        -- Performance indexes for new tables
        CREATE INDEX IF NOT EXISTS idx_custom_fields_sub_vertical_order ON custom_fields (sub_vertical_id, is_active, "order");
        CREATE INDEX IF NOT EXISTS idx_cost_conversion_custom_values_lead_id ON cost_conversion_custom_values (cost_conversion_id);
        CREATE INDEX IF NOT EXISTS idx_follow_ups_lead_date ON follow_ups (cost_conversion_id, follow_up_date);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_id ON audit_logs (actor_id);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs (action);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_target_collection ON audit_logs (target_collection);

        CREATE INDEX IF NOT EXISTS idx_follow_ups_sub_vertical_date ON follow_ups (sub_vertical_id, follow_up_date);
        CREATE INDEX IF NOT EXISTS idx_follow_ups_assigned_status_date ON follow_ups (assigned_to_id, status, follow_up_date);
        CREATE INDEX IF NOT EXISTS idx_follow_ups_date ON follow_ups (follow_up_date);
        CREATE INDEX IF NOT EXISTS idx_cost_conversions_lead_type ON cost_conversions (lead_type, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_cost_conversion_stages_sub_vertical ON cost_conversion_stages (sub_vertical_id, display_order);
        CREATE INDEX IF NOT EXISTS idx_cost_conversions_stage_id ON cost_conversions (stage_id);

        -- Statistics: help query planner on low-cardinality status/source columns
        ALTER TABLE cost_conversions ALTER COLUMN status SET STATISTICS 500;
        ALTER TABLE cost_conversions ALTER COLUMN source SET STATISTICS 200;

        -- ── NEW: Compound index for lead_type filter (replaces seq-scan on 10k+ rows)
        -- Covers: WHERE vertical_id = $1 AND is_deleted = false AND lead_type != 'POSITIVE'
        CREATE INDEX IF NOT EXISTS idx_cost_conversions_vertical_leadtype_created
            ON cost_conversions (vertical_id, lead_type, created_at DESC, id DESC)
            WHERE is_deleted = false;

        -- ── NEW: Worker queue poll index (FOR UPDATE SKIP LOCKED on status='queued')
        CREATE INDEX IF NOT EXISTS idx_csv_upload_logs_status_created
            ON csv_upload_logs (status, created_at ASC)
            WHERE status = 'queued';

        -- Autovacuum tuning for write-heavy import workloads
        ALTER TABLE cost_conversions SET (
            autovacuum_vacuum_scale_factor  = 0.05,
            autovacuum_analyze_scale_factor = 0.02,
            autovacuum_vacuum_cost_delay    = 2,
            fillfactor                      = 80
        );
    `;

    // ── Phase 3: Full-Text Search ────────────────────────────────────────────
    const ftsDdl = `
        -- GIN index on search_vector for fast @@ queries
        CREATE INDEX IF NOT EXISTS idx_cost_conversions_search_gin ON cost_conversions USING GIN (search_vector);

        -- Trigger: auto-maintain search_vector on every INSERT or relevant UPDATE
        CREATE OR REPLACE FUNCTION update_cost_conversion_search_vector()
        RETURNS TRIGGER AS $$
        BEGIN
            NEW.search_vector :=
                setweight(to_tsvector('english', coalesce(NEW.name, '')),          'A') ||
                setweight(to_tsvector('english', coalesce(NEW.business_name, '')), 'A') ||
                setweight(to_tsvector('english', coalesce(NEW.phone, '')),         'B');
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;

        DROP TRIGGER IF EXISTS trg_cost_conversions_search_vector ON cost_conversions;
        CREATE TRIGGER trg_cost_conversions_search_vector
            BEFORE INSERT OR UPDATE OF name, business_name, phone
            ON cost_conversions
            FOR EACH ROW EXECUTE FUNCTION update_cost_conversion_search_vector();
    `;

    try {
        await query(coreDdl);
        console.log('✅ Phase 1: Core schema migrations completed.');
    } catch (err) {
        console.error('❌ Phase 1 Migration Error:', err.message);
    }

    try {
        await query(perfDdl);
        console.log('✅ Phase 2: Performance index migrations completed.');
    } catch (err) {
        console.error('❌ Phase 2 Migration Error:', err.message);
    }

    try {
        await query(ftsDdl);
        console.log('✅ Phase 3: Full-text search setup completed.');

        // Backfill search_vector for existing rows asynchronously — non-blocking startup
        setImmediate(async () => {
            try {
                const result = await query(`
                    UPDATE cost_conversions
                    SET search_vector = (
                        setweight(to_tsvector('english', coalesce(name, '')),          'A') ||
                        setweight(to_tsvector('english', coalesce(business_name, '')), 'A') ||
                        setweight(to_tsvector('english', coalesce(phone, '')),         'B')
                    )
                    WHERE search_vector IS NULL AND is_deleted = false
                `);
                if (result.rowCount > 0) {
                    console.log(`✅ Backfilled search_vector for ${result.rowCount} existing cost conversions.`);
                }
            } catch (backfillErr) {
                console.error('⚠️ search_vector backfill (non-fatal):', backfillErr.message);
            }
        });
    } catch (err) {
        console.error('❌ Phase 3 Migration Error:', err.message);
    }

    // ── Phase 4: Cleanup & Composite Indexes ─────────────────────────────────
    const cleanupAndIndexDdl = `
        -- Drop legacy/dummy triggers
        DROP TRIGGER IF EXISTS trg_sync_business_details ON businesses CASCADE;
        DROP TRIGGER IF EXISTS trigger_businesses_updated_at ON businesses CASCADE;
        DROP TRIGGER IF EXISTS trigger_calls_updated_at ON calls CASCADE;
        DROP TRIGGER IF EXISTS trigger_followups_updated_at ON followups CASCADE;
        DROP TRIGGER IF EXISTS trigger_meetings_updated_at ON meetings CASCADE;
        DROP TRIGGER IF EXISTS trigger_summaries_updated_at ON call_summaries CASCADE;
        DROP TRIGGER IF EXISTS trigger_transcripts_updated_at ON call_transcripts CASCADE;

        -- Drop legacy/dummy functions
        DROP FUNCTION IF EXISTS sync_business_details() CASCADE;
        DROP FUNCTION IF EXISTS update_updated_at() CASCADE;

        -- Drop legacy/dummy tables (in dependency order)
        DROP TABLE IF EXISTS duplicate_checks CASCADE;
        DROP TABLE IF EXISTS employee_businesses CASCADE;
        DROP TABLE IF EXISTS employee_custom_timings CASCADE;
        DROP TABLE IF EXISTS employee_doubts CASCADE;
        DROP TABLE IF EXISTS employee_reports CASCADE;
        DROP TABLE IF EXISTS report_answers CASCADE;
        DROP TABLE IF EXISTS business_notes CASCADE;
        DROP TABLE IF EXISTS business_tags CASCADE;
        DROP TABLE IF EXISTS business_timings CASCADE;
        DROP TABLE IF EXISTS businesses CASCADE;
        DROP TABLE IF EXISTS call_notes CASCADE;
        DROP TABLE IF EXISTS call_summaries CASCADE;
        DROP TABLE IF EXISTS call_transcripts CASCADE;
        DROP TABLE IF EXISTS calls CASCADE;
        DROP TABLE IF EXISTS crm_audit_logs CASCADE;
        DROP TABLE IF EXISTS followups CASCADE;
        DROP TABLE IF EXISTS form_fields CASCADE;
        DROP TABLE IF EXISTS locations CASCADE;
        DROP TABLE IF EXISTS meetings CASCADE;
        DROP TABLE IF EXISTS notifications CASCADE;
        DROP TABLE IF EXISTS refresh_tokens CASCADE;
        DROP TABLE IF EXISTS targets CASCADE;
        DROP TABLE IF EXISTS tags CASCADE;
        DROP TABLE IF EXISTS activities CASCADE;
        DROP TABLE IF EXISTS activity_types CASCADE;
        DROP TABLE IF EXISTS ai_settings CASCADE;

        -- Composite Indexes for Audit Logs filtering + sorting performance
        CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_created_at ON audit_logs (actor_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_action_created_at ON audit_logs (action, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_target_created_at ON audit_logs (target_collection, created_at DESC);
    `;

    try {
        await query(cleanupAndIndexDdl);
        console.log('✅ Phase 4: Cleanup & Composite Indexes migrations completed.');
    } catch (err) {
        console.error('❌ Phase 4 Migration Error:', err.message);
    }

    // ── Phase 5: Materialized Views ──────────────────────────────────────────
    const mvDdl = `
        CREATE MATERIALIZED VIEW IF NOT EXISTS mv_vertical_tree AS
        SELECT
          v.id            AS vertical_id,
          v.name          AS vertical_name,
          v.color         AS vertical_color,
          v.display_order AS vertical_order,
          v.is_active     AS vertical_active,
          sv.id           AS sub_vertical_id,
          sv.name         AS sub_vertical_name,
          sv.slug         AS sub_vertical_slug,
          sv.display_order AS sub_vertical_order,
          sv.is_active    AS sub_vertical_active
        FROM verticals v
        LEFT JOIN sub_verticals sv ON sv.vertical_id = v.id AND sv.is_active = true
        WHERE v.is_active = true
        ORDER BY v.display_order, sv.display_order;

        CREATE UNIQUE INDEX IF NOT EXISTS mv_vertical_tree_pk ON mv_vertical_tree (vertical_id, sub_vertical_id);

        CREATE OR REPLACE FUNCTION refresh_mv_vertical_tree()
        RETURNS TRIGGER AS $$
        BEGIN
          REFRESH MATERIALIZED VIEW CONCURRENTLY mv_vertical_tree;
          RETURN NULL;
        END;
        $$ LANGUAGE plpgsql;

        DROP TRIGGER IF EXISTS trg_refresh_vertical_tree_on_vertical ON verticals;
        CREATE TRIGGER trg_refresh_vertical_tree_on_vertical
          AFTER INSERT OR UPDATE OR DELETE ON verticals
          FOR EACH STATEMENT EXECUTE FUNCTION refresh_mv_vertical_tree();

        DROP TRIGGER IF EXISTS trg_refresh_vertical_tree_on_subvertical ON sub_verticals;
        CREATE TRIGGER trg_refresh_vertical_tree_on_subvertical
          AFTER INSERT OR UPDATE OR DELETE ON sub_verticals
          FOR EACH STATEMENT EXECUTE FUNCTION refresh_mv_vertical_tree();

        CREATE MATERIALIZED VIEW IF NOT EXISTS mv_vertical_stats AS
        SELECT
          v.id    AS vertical_id,
          v.name  AS vertical_name,
          v.color AS color,
          COUNT(cc.id) AS total_cost_conversions,
          COUNT(cc.id) FILTER (WHERE cc.status = 'NEW' OR cc.status = 'new')       AS new_count,
          COUNT(cc.id) FILTER (WHERE cc.status = 'WON' OR cc.status = 'won' OR cc.status = 'converted')        AS won_count,
          COUNT(cc.id) FILTER (WHERE cc.status = 'CONTACTED' OR cc.status = 'contacted')  AS contacted_count,
          MAX(cc.created_at) AS last_activity_at
        FROM verticals v
        LEFT JOIN sub_verticals sv    ON sv.vertical_id = v.id AND sv.is_active = true
        LEFT JOIN cost_conversions cc ON cc.sub_vertical_id = sv.id AND cc.is_deleted = false
        WHERE v.is_active = true
        GROUP BY v.id, v.name, v.color;

        CREATE UNIQUE INDEX IF NOT EXISTS mv_vertical_stats_pk ON mv_vertical_stats (vertical_id);
    `;

    try {
        await query(mvDdl);
        console.log('✅ Phase 5: Materialized Views setup completed.');
    } catch (err) {
        console.error('❌ Phase 5 Migration Error:', err.message);
    }

    console.log('✅ All database migrations completed.');
};

export default pool;
