# 🚀 FlowX

### Modern API Testing & Workflow Automation Platform

FlowX is a modern API testing platform designed to simplify API development, testing, and automation.

Instead of testing API requests individually, FlowX lets you **build complete API workflows**, connect multiple requests, pass data between steps, execute test flows, and validate results from a single workspace.

---

## ✨ Why FlowX?

Traditional API clients are great for sending individual requests, but testing a real-world API often involves multiple dependent requests.

For example:

```text
Login
  ↓
Get Access Token
  ↓
Get User
  ↓
Extract User ID
  ↓
Update User
  ↓
Validate Response
```

With FlowX, these requests can be connected into a single reusable workflow.

---

## 🎯 Key Features

### 🔗 API Workflow Builder

Build multi-step API workflows by connecting requests together.

```text
Request 1 → Request 2 → Request 3 → Request 4
```

Each step can use data produced by previous steps.

---

### 🔄 Request Chaining

Automatically pass values from one API response to another request.

Example:

```json
{
  "token": "abc123",
  "user": {
    "id": 42
  }
}
```

Extract values:

```text
token → accessToken
user.id → userId
```

Use them in later requests:

```text
Authorization: Bearer {{accessToken}}

GET /users/{{userId}}
```

No manual copy-paste required.

---

### 🌍 Environment & Test Data

Manage reusable variables and test data across API workflows.

Example:

```text
{{baseUrl}}
{{username}}
{{password}}
{{accessToken}}
{{userId}}
```

This makes the same workflow reusable across different environments and test scenarios.

---

### 📖 Swagger / OpenAPI Integration

Import API specifications and select endpoints directly while building workflows.

FlowX helps turn your existing API documentation into executable API test flows.

---

### 🧪 API Validation

Validate API responses using configurable assertions such as:

* HTTP status codes
* Response values
* Expected conditions
* Extracted variables
* Step-level validation

---

### 🤖 AI-Powered Analysis

FlowX can use AI-assisted analysis to evaluate API test results and provide additional insights.

This helps identify unexpected responses and makes test results easier to understand.

---

### ▶️ Flow Execution

Execute an entire API workflow instead of manually running individual requests.

```text
Start
  ↓
Step 1
  ↓
Extract Data
  ↓
Step 2
  ↓
Extract Data
  ↓
Step 3
  ↓
Validate
  ↓
Result
```

---

### 📊 Run History & Reports

Track previous executions and inspect:

* Passed steps
* Failed steps
* Response data
* Execution results
* Validation results
* Flow-level status

---

### 💻 Test Code Generation

Generate automated test code from API workflows to help integrate API tests into existing automation projects.

---

## 🏗️ Architecture

```text
                    ┌─────────────────┐
                    │  Swagger/OpenAPI│
                    └────────┬────────┘
                             ↓
                    ┌─────────────────┐
                    │  Flow Builder   │
                    └────────┬────────┘
                             ↓
              ┌─────────────────────────────┐
              │        API Flow             │
              │                             │
              │ Step 1 → Step 2 → Step 3   │
              └──────────────┬──────────────┘
                             ↓
                    ┌─────────────────┐
                    │  Flow Engine    │
                    └────────┬────────┘
                             ↓
                    ┌─────────────────┐
                    │ API Execution   │
                    └────────┬────────┘
                             ↓
                ┌────────────────────────┐
                │ Extraction & Validation│
                └───────────┬────────────┘
                            ↓
                    ┌─────────────────┐
                    │ Results / Report│
                    └─────────────────┘
```

---

## 🛠️ Tech Stack

### Frontend

* React
* Vite
* JavaScript
* CSS

### Backend

* Node.js
* Express.js

### Database

* MongoDB

### AI

* Gemini / LLM integration

### API Testing

* REST API execution
* Swagger / OpenAPI
* Custom validation engine

---

## 📁 Project Structure

```text
FlowX/
│
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   ├── context/
│   │   └── ...
│   └── package.json
│
├── backend/
│   ├── models/
│   ├── routes/
│   ├── services/
│   ├── flowEngine.js
│   └── ...
│
├── .gitignore
├── README.md
└── package.json
```

> The exact structure may vary depending on the current project configuration.

---

## 🚀 Getting Started

### 1. Clone the repository

```bash
git clone <repository-url>

cd FlowX
```

### 2. Install dependencies

Frontend:

```bash
cd frontend
npm install
```

Backend:

```bash
cd backend
npm install
```

### 3. Configure environment variables

Create a `.env` file in the backend:

```env
PORT=5000
MONGODB_URI=your_mongodb_connection_string
GEMINI_API_KEY=your_gemini_api_key
```

**Never commit your `.env` file to GitHub.**

Use `.env.example` for sharing required environment variable names.

---

## ▶️ Running the Application

Start the backend:

```bash
cd backend
npm run dev
```

Start the frontend:

```bash
cd frontend
npm run dev
```

Then open the frontend URL shown by Vite in your browser.

---

## 🔄 Example Workflow

A typical FlowX workflow could look like:

```text
┌─────────────┐
│ Login API   │
└──────┬──────┘
       │
       │ Extract token
       ↓
┌─────────────┐
│ Get User API│
└──────┬──────┘
       │
       │ Extract userId
       ↓
┌─────────────┐
│ Update User │
└──────┬──────┘
       │
       ↓
┌─────────────┐
│ Validate    │
└─────────────┘
```

The important part is that **data flows automatically between dependent API requests**.

---

## 💡 Use Cases

FlowX can be used for:

* API functional testing
* API regression testing
* End-to-end API workflows
* Request chaining
* Test data-driven API testing
* Swagger-based API testing
* API validation
* Automated API execution
* API test reporting
* AI-assisted test analysis

---

## 🆚 FlowX vs Traditional API Clients

| Capability                | Traditional API Client | FlowX |
| ------------------------- | ---------------------- | ----- |
| Individual API requests   | ✅                      | ✅     |
| Multi-step workflows      | Limited                | ✅     |
| Request chaining          | Manual / Script-based  | ✅     |
| Automatic data extraction | Limited                | ✅     |
| Swagger integration       | ✅                      | ✅     |
| Reusable test data        | ✅                      | ✅     |
| Flow execution            | Limited                | ✅     |
| Run history               | ✅                      | ✅     |
| AI-assisted analysis      | Limited                | ✅     |
| Test code generation      | Limited                | ✅     |

FlowX is focused on making **dependent API testing and workflow automation** easier.

---

## 🔮 Future Improvements

Planned improvements may include:

* Advanced assertion builder
* More authentication methods
* Better environment management
* Scheduled test execution
* CI/CD integration
* Team collaboration
* Advanced test reporting
* More code-generation targets
* Improved AI-assisted debugging

---

## 🤝 Contributing

Contributions, ideas, and feedback are welcome.

If you find a bug or have an idea for improvement, feel free to open an issue or submit a pull request.

---

## 📄 License

This project is currently under development.

License information will be added as the project is finalized.

---

## ⭐ FlowX

**Build API flows. Connect requests. Automate testing.**
