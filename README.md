This is the backend API for the Project Management Application.
It provides:

User Authentication (Signup & Login)

JWT-based Authorization

CRUD operations for Projects

CRUD operations for Tasks inside projects

Backend is built using:

Node.js

Express

MongoDB + Mongoose

JWT Authentication

TypeScript / JavaScript

CORS, dotenv, bcrypt

📌 Features
🔐 Authentication

User Signup

User Login

Password hashing using bcryptjs

JWT-based session management

📁 Projects

Create a project

Update a project

Delete a project

View all projects (for logged-in user only)

✅ Tasks

Each project can have multiple tasks.

Task fields:

title

description

status → todo / in-progress / done

due_date

Task operations:

Create task

Update task

Delete task

List all tasks for a project

📂 Folder Structure
server/
│── index.ts / index.js (Main entry)
│── db.ts (Mongo connection)
│── routes.ts (API routes)
│── static.ts
│── storage.ts
│── vite.ts
│── ...
└── shared/schema.ts (Shared Zod Schema)

🛠 Installation
1️⃣ Install dependencies
npm install

2️⃣ Create .env file

In the server/ folder create:

MONGO_URL=your_mongo_url_here
JWT_SECRET=your_secret_key
PORT=5000


Use MongoDB Atlas or Local MongoDB.

3️⃣ Run server
npm start


Server will run at:
👉 http://localhost:5000

🔌 API Endpoints
Auth
POST /auth/signup
POST /auth/login

Projects
GET /projects
POST /projects
PUT /projects/:id
DELETE /projects/:id

Tasks
GET /projects/:id/tasks
POST /projects/:id/tasks
PUT /tasks/:taskId
DELETE /tasks/:taskId

🔒 JWT Authorization

Send token in header:

Authorization: Bearer <token>

🧪 Testing the API (Postman)

Signup

Login → get token

Add token in header

Call project/task endpoints
