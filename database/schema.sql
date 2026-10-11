CREATE DATABASE IF NOT EXISTS nlqueryengine CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE nlqueryengine;

-- The API creates/updates application tables automatically on startup.
-- This file documents the expected schema for reference.

-- users: id, email (unique), password_hash, role (enum), name, avatar, is_active, created_at
-- datasets: id, name (unique), table_name (unique), original_filename, row_count, column_count, created_by (FK users), created_at
-- dataset_columns: id, dataset_id (FK datasets), name, data_type (enum), position_no
-- dashboards: id, title, description, dataset_id (FK datasets), created_by (FK users), charts (JSON), created_at, updated_at
-- dashboard_access: dashboard_id (FK dashboards), user_id (FK users) -- composite PK
-- dataset_requests: id, requested_by (FK users), description, status (enum), created_at
-- query_history: id, user_id (FK users), dataset_id (FK datasets), natural_query, sql_text, row_count, created_at
-- saved_queries: id, name, natural_query, dataset_id (FK datasets), sql_text, visualization_type, created_by (FK users), created_at
-- audit_logs: id, user_id (FK users), action, details, created_at

-- Uploaded CSV files become isolated MySQL tables prefixed with data_ with __row_id as PK.
