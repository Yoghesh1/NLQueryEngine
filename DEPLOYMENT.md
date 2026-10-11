# NLQueryEngine Deployment

## Architecture
- React/Vite frontend
- Node/Express backend
- Managed MySQL 8+

No Docker is required.

## MySQL
Create a managed MySQL database and note its host, port, database name, username and password. The backend creates its application tables automatically on startup.

## Backend
Deploy the `backend` directory as a Node service.

Build/install:
`npm install`

Start:
`npm start`

Environment variables:
- `PORT=4000`
- `FRONTEND_URL=https://YOUR-FRONTEND-DOMAIN`
- `JWT_SECRET=<strong-random-secret>`
- `DB_HOST=<mysql-host>`
- `DB_PORT=3306`
- `DB_NAME=nlqueryengine`
- `DB_USER=<mysql-user>`
- `DB_PASSWORD=<mysql-password>`

Health check:
`/api/health`

## Frontend
Deploy the `frontend` directory as a Vite/React site.

Build:
`npm install && npm run build`

Output:
`dist`

Set:
`VITE_API_URL=https://YOUR-BACKEND-DOMAIN/api`

For Vercel, set the project Root Directory to `frontend`.

## GitHub monorepo
```text
NLQueryEngine/
  frontend/
  backend/
  database/
  scripts/
```

Never commit `.env` files.
