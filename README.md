# NLQueryEngine

A full-stack natural-language analytics dashboard based on the original React prototype.

## Stack
- Frontend: React + Vite
- Backend: Node.js + Express
- Database: MySQL 8+
- Authentication: JWT + bcrypt
- Dataset ingestion: CSV -> isolated MySQL tables
- Query engine: deterministic natural-language-to-MySQL SQL rules (no Anthropic/OpenAI key required)

## Project structure
```text
NLQueryEngine/
├── frontend/       React/Vite app
├── backend/        Express REST API
├── database/       MySQL schema + local reset script
├── scripts/        smoke checks
└── deployment files
```

## Local setup (Windows)

### 1. Start MySQL
Start MySQL from XAMPP, MySQL Workbench/service, or your normal MySQL installation.

The backend can create the `nlqueryengine` database automatically when the MySQL account has permission to create databases.

If you need a completely fresh local database, run `database/reset-local.sql` once in MySQL. **This deletes all local project data.**

### 2. Backend terminal
```powershell
cd D:\path\to\NLQueryEngine\backend
npm install
copy .env.example .env
npm run dev
```

Edit `backend/.env` if your MySQL username/password differs.

Backend: `http://localhost:4000`
Health: `http://localhost:4000/api/health`

### 3. Frontend terminal
Open a second terminal:
```powershell
cd D:\path\to\NLQueryEngine\frontend
npm install
copy .env.example .env
npm run dev
```

Frontend: `http://localhost:5173`

Keep both terminals running.

## Demo accounts
| Role | Email | Password |
|---|---|---|
| Admin | admin@nlquery.io | admin123 |
| Manager | manager@nlquery.io | mgr123 |
| Analyst | analyst@nlquery.io | ana123 |
| Viewer | viewer@nlquery.io | view123 |

These are development/demo credentials only. Change or remove them before production.

## RBAC
- Admin: users, upload, query, analytics, requests, dashboards
- Manager: query, analytics, requests, permitted dashboards
- Analyst: query, analytics, dashboard builder, requests
- Viewer: analytics and dashboards explicitly shared with them

RBAC is enforced on the backend as well as reflected in the frontend navigation.

## Useful checks
From the repository root:
```powershell
node scripts/smoke-check.mjs
```

From `backend`:
```powershell
npm run check
```

## Deployment
Deploy `frontend` and `backend` as separate services from the same GitHub repository. Use a managed MySQL 8+ database.

Frontend environment:
```env
VITE_API_URL=https://YOUR-BACKEND-DOMAIN/api
```

Backend environment:
```env
PORT=4000
FRONTEND_URL=https://YOUR-FRONTEND-DOMAIN
JWT_SECRET=your-long-random-secret
DB_HOST=your-mysql-host
DB_PORT=3306
DB_NAME=nlqueryengine
DB_USER=your-mysql-user
DB_PASSWORD=your-mysql-password
```

Do not commit `.env` files or database passwords.
No Docker is required.
