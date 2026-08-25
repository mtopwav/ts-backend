// @ts-nocheck
require("./loadEnv");
const path = require("path");
const express = require("express");
const cors = require("cors");
const compression = require("compression");
const bcrypt = require("bcrypt");
const promisePool = require("./database");
const {
  isOnfonConfigured,
  isOnfonBalanceConfigured,
  getOnfonBalance,
  sendBulkMessages,
  normalizePhoneForOnfon,
  formatUnitsDisplay
} = require("./onfonSms");

const app = express();

// Branch location helpers (Boma / Geita isolation)
function normalizeBranchLocation(value) {
  if (value == null || String(value).trim() === "") return null;
  const s = String(value).trim().toLowerCase();
  if (s === "boma") return "Boma";
  if (s === "geita") return "Geita";
  return String(value).trim();
}

async function ensureTableColumn(table, column, ddl) {
  try {
    await promisePool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  } catch (e) {
    const isDup =
      e.errno === 1060 ||
      e.code === "ER_DUP_FIELDNAME" ||
      (e.message && e.message.includes("Duplicate column"));
    if (!isDup) throw e;
  }
}

async function tableHasColumn(table, column) {
  const [rows] = await promisePool.query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return Number(rows[0]?.cnt) > 0;
}

async function backfillPaymentsLocationFromEmployees() {
  if (!(await tableHasColumn("payments", "location"))) return;
  try {
    await promisePool.query(`
      UPDATE payments p
      INNER JOIN employees e ON p.employee_id = e.id
      SET p.location = TRIM(e.location)
      WHERE (p.location IS NULL OR TRIM(p.location) = '')
        AND e.location IS NOT NULL AND TRIM(e.location) <> ''
    `);
  } catch (e) {
    if (e.code !== "ER_BAD_FIELD_ERROR" && e.errno !== 1054) throw e;
  }
}

async function backfillCustomersLocationFromPayments() {
  if (!(await tableHasColumn("customers", "location"))) return;
  if (!(await tableHasColumn("payments", "location"))) return;
  try {
    await promisePool.query(`
      UPDATE customers c
      INNER JOIN (
        SELECT p.customer_id, p.location
        FROM payments p
        INNER JOIN (
          SELECT customer_id, MAX(id) AS max_id
          FROM payments
          WHERE location IS NOT NULL AND TRIM(location) <> ''
          GROUP BY customer_id
        ) latest ON p.id = latest.max_id
      ) src ON c.id = src.customer_id
      SET c.location = src.location
      WHERE c.location IS NULL OR TRIM(c.location) = ''
    `);
  } catch (e) {
    if (e.code !== "ER_BAD_FIELD_ERROR" && e.errno !== 1054) throw e;
  }
}

async function backfillLoansLocationFromPayments() {
  if (!(await tableHasColumn("loans", "location"))) return;
  if (!(await tableHasColumn("payments", "location"))) return;
  try {
    await promisePool.query(`
      UPDATE loans l
      INNER JOIN payments p ON l.payment_id = p.id
      SET l.location = p.location
      WHERE (l.location IS NULL OR TRIM(l.location) = '')
        AND p.location IS NOT NULL AND TRIM(p.location) <> ''
    `);
  } catch (e) {
    if (e.code !== "ER_BAD_FIELD_ERROR" && e.errno !== 1054) throw e;
  }
}

// Faster responses: gzip JSON payloads
app.use(compression());

// CORS — localhost allowed in development; CLIENT_URL for production
const allowedOrigins = (process.env.CLIENT_URL || "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const isDev = (process.env.NODE_ENV || "development") !== "production";

app.use(cors({
  origin(origin, callback) {
    // curl / same-machine / no browser Origin
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes("*")) return callback(null, true);
    if (isDev && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
      return callback(null, true);
    }
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    // Never throw here — throwing becomes {"message":"Internal server error"} on login
    console.warn(`[CORS] Blocked origin: ${origin}. Allowed: ${allowedOrigins.join(", ") || "(none)"}`);
    callback(null, false);
  },
  credentials: true
}));
app.use(express.json({ limit: "1mb" }));

// API root — health/info for GET /api (VPS proxy checks, browser tests)
app.get("/api", async (req, res) => {
  try {
    await promisePool.query("SELECT 1");
    res.json({
      success: true,
      message: "Thiago Auto Spare API is running",
      database: "connected",
      endpoints: {
        health: "/api/health",
        login: "POST /api/login",
        test: "/api/test"
      }
    });
  } catch (error) {
    res.status(503).json({
      success: false,
      message: "Thiago Auto Spare API is running but database is unavailable",
      database: "disconnected",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
});

// Test endpoint
app.get("/api/test", (req, res) => {
  res.json({ message: "Hello from Node.js - Server is connected!" });
});

// Test database connection
app.get("/api/test-db", async (req, res) => {
  try {
    const [rows] = await promisePool.query("SELECT 1 AS test");
    res.json({
      success: true,
      message: "Database connection successful!",
      data: rows
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Database connection failed",
      error: error.message
    });
  }
});

// Debug endpoint - Check admin table structure
app.get("/api/debug-admin", async (req, res) => {
  try {
    // Check if admin table exists and get structure
    const [tableInfo] = await promisePool.query("DESCRIBE admin");
    const [adminData] = await promisePool.query("SELECT id, username FROM admin");

    res.json({
      success: true,
      tableStructure: tableInfo,
      adminUsers: adminData,
      message: "Admin table structure retrieved"
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error checking admin table",
      error: error.message
    });
  }
});

// Ensure main table exists (for main dashboard login)
async function ensureMainTable() {
  await promisePool.query(`
    CREATE TABLE IF NOT EXISTS main (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(100) NOT NULL,
      password VARCHAR(255) NOT NULL
    )
  `);
}

async function ensureAdminUsernameColumn() {
  try {
    const [cols] = await promisePool.query("SHOW COLUMNS FROM admin");
    const names = cols.map((c) => c.Field);
    if (names.includes("usename") && !names.includes("username")) {
      await promisePool.query(
        "ALTER TABLE admin CHANGE usename username VARCHAR(255) NOT NULL"
      );
      console.log("Renamed admin.usename column to username");
    }
  } catch (error) {
    if (error.code !== "ER_NO_SUCH_TABLE") {
      console.error("Admin column check:", error.message);
    }
  }
}

// Login endpoint - Fetches data from database (admin from table admin, main from main, employees from employees)
// Admin table: id, username, password (plain text). On success redirect to /admin/dashboard.
// Main table: id, username, password. On success redirect to /main/dashboard.
app.post("/api/login", async (req, res) => {
  try {
    const { username, password, email, location, branch, loginType } = req.body;

    if (!password) {
      return res.status(400).json({
        success: false,
        message: "Password is required"
      });
    }

    const locationVal = String(location ?? branch ?? "").trim();
    const isEmployeeLogin = loginType === "employee" || Boolean(locationVal);

    // Employee login: location + password
    if (isEmployeeLogin) {
      if (!locationVal) {
        return res.status(400).json({
          success: false,
          message: "Location is required (Boma or Geita)"
        });
      }
      await ensureEmployeesTable();
      await ensureLocationColumn();

      const [employees] = await promisePool.query(
        `SELECT id, full_name, phone, position, department, \`location\`, password_hash, password, status
         FROM employees
         WHERE LOWER(TRIM(\`location\`)) = LOWER(?)`,
        [locationVal]
      );

      let authenticatedEmployee = null;

      for (const employee of employees) {
        const statusVal = String(employee.status || "Active").trim().toLowerCase();
        if (statusVal && statusVal !== "active") continue;

        if (employee.password_hash) {
          const isHashedMatch = await bcrypt.compare(password, employee.password_hash);
          if (isHashedMatch) {
            authenticatedEmployee = employee;
            break;
          }
        }

        if (employee.password && String(password) === String(employee.password)) {
          authenticatedEmployee = employee;
          break;
        }
      }

      if (authenticatedEmployee) {
        console.log(
          "✅ Employee login successful:",
          authenticatedEmployee.full_name,
          "@",
          authenticatedEmployee.location
        );
        return res.json({
          success: true,
          message: "Login successful",
          user: {
            id: authenticatedEmployee.id,
            username: authenticatedEmployee.department,
            full_name: authenticatedEmployee.full_name,
            phone: authenticatedEmployee.phone,
            position: authenticatedEmployee.position,
            department: authenticatedEmployee.department,
            location: authenticatedEmployee.location,
            status: authenticatedEmployee.status,
            userType: "employee"
          }
        });
      }

      return res.status(401).json({
        success: false,
        message: "Invalid location or password"
      });
    }

    // Admin / main login: username + password
    const loginIdentifier = (email || username || "").trim();

    if (!loginIdentifier) {
      return res.status(400).json({
        success: false,
        message:
          loginType === "admin"
            ? "Username and password are required"
            : "Please select your location (Boma or Geita)"
      });
    }

    // 1. Try Admin tables first (by username)
    const [admins] = await promisePool.query(
      "SELECT id, username, password FROM admin WHERE username = ?",
      [loginIdentifier]
    );

    if (admins.length > 0) {
      const admin = admins[0];
      const plainMatch = admin.password != null && password === String(admin.password);
      const hashedMatch = admin.password && (admin.password.startsWith('$2a$') || admin.password.startsWith('$2b$') || admin.password.startsWith('$2y$'))
        ? await bcrypt.compare(password, admin.password)
        : false;

      if (plainMatch || hashedMatch) {
        console.log('✅ Admin login successful:', admin.username);
        return res.json({
          success: true,
          message: "Login successful",
          user: {
            id: admin.id,
            username: admin.username,
            userType: "admin"
          }
        });
      }
    }

    // 2. Try Main table (by username) - same access as admin
    await ensureMainTable();
    const [mainUsers] = await promisePool.query(
      "SELECT id, username, password FROM main WHERE username = ?",
      [loginIdentifier]
    );
    if (mainUsers.length > 0) {
      const mainUser = mainUsers[0];
      const plainMatch = mainUser.password != null && password === String(mainUser.password);
      const hashedMatch = mainUser.password && (mainUser.password.startsWith('$2a$') || mainUser.password.startsWith('$2b$') || mainUser.password.startsWith('$2y$'))
        ? await bcrypt.compare(password, mainUser.password)
        : false;
      if (plainMatch || hashedMatch) {
        console.log('Main login successful:', mainUser.username);
        return res.json({
          success: true,
          message: "Login successful",
          user: {
            id: mainUser.id,
            username: mainUser.username,
            // Treat main users as admins for access control
            userType: "admin"
          }
        });
      }
    }

    // 3. Try Employee login with a more robust search
    console.log('🔍 Searching for employee with identifier:', loginIdentifier);

    await ensureEmployeesTable();

    // Normalize phone number if user provided one (remove non-digits and handle prefixes)
    let phoneSearch = loginIdentifier.replace(/\D/g, '');
    let searchIdentifiers = [loginIdentifier];
    if (phoneSearch.length >= 9) {
      const last9 = phoneSearch.slice(-9);
      searchIdentifiers.push('+255' + last9);
      searchIdentifiers.push('0' + last9);
      searchIdentifiers.push(last9);
    }

    // Query for employees by Full Name, Phone, Department, or Position
    // We search across multiple fields to make it as easy as possible for the user
    const [employees] = await promisePool.query(
      `SELECT id, full_name, phone, position, department, password_hash, password 
       FROM employees 
       WHERE LOWER(full_name) = LOWER(?) 
          OR phone IN (?) 
          OR LOWER(department) = LOWER(?) 
          OR LOWER(position) = LOWER(?)`,
      [loginIdentifier, searchIdentifiers, loginIdentifier, loginIdentifier]
    );

    console.log(`📊 Found ${employees.length} potential employee matches`);

    if (employees.length > 0) {
      let authenticatedEmployee = null;

      for (const employee of employees) {
        // A. Check hashed password (preferred)
        if (employee.password_hash) {
          const isHashedMatch = await bcrypt.compare(password, employee.password_hash);
          if (isHashedMatch) {
            authenticatedEmployee = employee;
            break;
          }
        }

        // B. Check plain text password (fallback for older/manually imported records)
        if (employee.password && String(password) === String(employee.password)) {
          authenticatedEmployee = employee;
          break;
        }
      }

      if (authenticatedEmployee) {
        console.log('✅ Employee login successful:', authenticatedEmployee.full_name);
        return res.json({
          success: true,
          message: "Login successful",
          user: {
            id: authenticatedEmployee.id,
            username: authenticatedEmployee.department, // Keep for backward compatibility
            full_name: authenticatedEmployee.full_name,
            phone: authenticatedEmployee.phone,
            position: authenticatedEmployee.position,
            department: authenticatedEmployee.department,
            userType: 'employee'
          }
        });
      }
    }

    // 3. Final Fallback: Invalid credentials
    console.warn('❌ Login failed for identifier:', loginIdentifier);
    return res.status(401).json({
      success: false,
      message: "Invalid username or password"
    });

  } catch (error) {
    console.error("Login error:", error);
    console.error("Error details:", {
      message: error.message,
      code: error.code,
      sqlMessage: error.sqlMessage,
      stack: error.stack
    });
    res.status(500).json({
      success: false,
      message: "An error occurred during login",
      // Always include a short DB/code hint so VPS login issues are diagnosable
      error: error.sqlMessage || error.message || undefined
    });
  }
});

// Change Admin Password endpoint
app.put("/api/admin/change-password", async (req, res) => {
  try {
    console.log("PUT /api/admin/change-password");

    const { username, currentPassword, newPassword } = req.body;

    if (!username || !currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Username, current password, and new password are required"
      });
    }

    // Fetch admin data from database
    const [admins] = await promisePool.query(
      "SELECT id, username, password FROM admin WHERE username = ?",
      [username]
    );

    if (admins.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Admin user not found"
      });
    }

    const admin = admins[0];

    // Verify current password
    if (!admin.password) {
      return res.status(500).json({
        success: false,
        message: "Password not found in database"
      });
    }

    // Check if password is hashed (bcrypt hashes start with $2a$, $2b$, or $2y$)
    const isHashed = admin.password.startsWith('$2a$') ||
      admin.password.startsWith('$2b$') ||
      admin.password.startsWith('$2y$');

    let isPasswordValid = false;

    if (isHashed) {
      // Password is hashed, use bcrypt to verify
      isPasswordValid = await bcrypt.compare(currentPassword, admin.password);
    } else {
      // Password is plain text, do direct comparison
      isPasswordValid = currentPassword === admin.password;
    }

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: "Current password is incorrect"
      });
    }

    // Validate new password length
    if (newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message: "New password must be at least 8 characters long"
      });
    }

    // Hash the new password
    console.log("Hashing new password for admin:", username);
    console.log("New password (before hash):", newPassword);

    if (!newPassword || newPassword.trim() === '') {
      return res.status(400).json({
        success: false,
        message: "New password cannot be empty"
      });
    }

    let password_hash;
    try {
      password_hash = await bcrypt.hash(newPassword, 10);
      console.log("Password hashed successfully");
      console.log("Hashed password (first 20 chars):", password_hash.substring(0, 20) + "...");
      console.log("Hash length:", password_hash.length);

      // Verify hash was created (should start with $2a$, $2b$, or $2y$)
      if (!password_hash || !password_hash.startsWith('$2')) {
        throw new Error("Failed to generate valid bcrypt hash");
      }
    } catch (hashError) {
      console.error("Error hashing password:", hashError);
      return res.status(500).json({
        success: false,
        message: "Failed to hash password",
        error: process.env.NODE_ENV === "development" ? hashError.message : undefined
      });
    }

    // Update password in database (storing hashed password)
    try {
      const [updateResult] = await promisePool.query(
        "UPDATE admin SET password = ? WHERE username = ?",
        [password_hash, username]
      );

      console.log("Update result:", updateResult);
      console.log("Rows affected:", updateResult.affectedRows);

      if (updateResult.affectedRows === 0) {
        return res.status(500).json({
          success: false,
          message: "Failed to update password - no rows affected"
        });
      }

      // Verify the password was stored correctly
      const [verify] = await promisePool.query(
        "SELECT password FROM admin WHERE username = ?",
        [username]
      );

      if (verify.length > 0) {
        const storedPassword = verify[0].password;
        console.log("Stored password (first 20 chars):", storedPassword ? storedPassword.substring(0, 20) + "..." : "NULL");
        const isHash = storedPassword && (storedPassword.startsWith('$2a$') || storedPassword.startsWith('$2b$') || storedPassword.startsWith('$2y$'));
        console.log("Is stored password a hash?", isHash);

        if (!isHash) {
          console.error("WARNING: Password was not stored as a hash!");
          return res.status(500).json({
            success: false,
            message: "Password was not stored correctly as a hash"
          });
        }
      }

      console.log("Admin password updated successfully (hashed and stored in password column)");
    } catch (updateError) {
      console.error("Error updating password in database:", updateError);
      return res.status(500).json({
        success: false,
        message: "Failed to update password in database",
        error: process.env.NODE_ENV === "development" ? updateError.message : undefined
      });
    }

    res.json({
      success: true,
      message: "Password updated successfully"
    });

  } catch (error) {
    console.error("Change password error:", error);
    res.status(500).json({
      success: false,
      message: "An error occurred while changing password",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
});

// Health check
app.get("/api/health", async (req, res) => {
  try {
    await promisePool.query("SELECT 1");
    res.json({
      status: "OK",
      message: "Server and database are running",
      database: "connected"
    });
  } catch (error) {
    res.status(500).json({
      status: "ERROR",
      message: "Server is running but database connection failed",
      database: "disconnected",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
});

// Helper function to ensure password column exists
// Create employees table if not exists (name, phone, position, department, password, salary - no status)
async function ensureEmployeesTable() {
  await promisePool.query(`
    CREATE TABLE IF NOT EXISTS employees (
      id INT AUTO_INCREMENT PRIMARY KEY,
      full_name VARCHAR(255) NOT NULL,
      phone VARCHAR(50) NOT NULL,
      location VARCHAR(255) NOT NULL DEFAULT '',
      position VARCHAR(100) NOT NULL,
      department VARCHAR(100) NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'Active',
      salary DECIMAL(12,2) NULL,
      password_hash VARCHAR(255) NULL,
      password VARCHAR(255) NULL,
      join_date DATE NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_department (department),
      INDEX idx_position (position),
      INDEX idx_phone (phone),
      INDEX idx_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function ensurePasswordColumn() {
  try {
    const [columns] = await promisePool.query(
      `SHOW COLUMNS FROM employees LIKE 'password'`
    );
    if (columns.length === 0) {
      console.log("Adding 'password' column to employees table...");
      await promisePool.query(
        `ALTER TABLE employees 
         ADD COLUMN password VARCHAR(255) NULL AFTER password_hash`
      );
      console.log("Password column added successfully");
    }
  } catch (error) {
    console.error("⚠️ Error checking/adding password column:", error.message);
  }
}

async function ensureSalaryColumn() {
  try {
    const [columns] = await promisePool.query(
      `SHOW COLUMNS FROM employees LIKE 'salary'`
    );
    if (columns.length === 0) {
      console.log("Adding 'salary' column to employees table...");
      await promisePool.query(
        `ALTER TABLE employees ADD COLUMN salary DECIMAL(12,2) NULL`
      );
      console.log("Salary column added successfully");
    }
  } catch (error) {
    console.error("⚠️ Error checking/adding salary column:", error.message);
  }
}

async function ensureStatusColumn() {
  try {
    const [columns] = await promisePool.query(
      `SHOW COLUMNS FROM employees LIKE 'status'`
    );
    if (columns.length === 0) {
      console.log("Adding 'status' column to employees table...");
      await promisePool.query(
        `ALTER TABLE employees ADD COLUMN status VARCHAR(50) DEFAULT 'Active' AFTER department`
      );
      console.log("Status column added successfully");
    }
  } catch (error) {
    console.error("⚠️ Error checking/adding status column:", error.message);
  }
}

async function ensureLocationColumn() {
  try {
    const [columns] = await promisePool.query(
      `SHOW COLUMNS FROM employees LIKE 'location'`
    );
    if (columns.length === 0) {
      console.log("Adding 'location' column to employees table...");
      await promisePool.query(
        `ALTER TABLE employees ADD COLUMN location VARCHAR(255) NOT NULL DEFAULT '' AFTER phone`
      );
      console.log("Location column added successfully");
    }
  } catch (error) {
    console.error("⚠️ Error checking/adding location column:", error.message);
  }
}

// Get all employees endpoint
app.get("/api/employees", async (req, res) => {
  try {
    console.log("GET /api/employees - Fetching all employees");
    await ensureEmployeesTable();
    await ensurePasswordColumn();
    await ensureSalaryColumn();
    await ensureLocationColumn();
    await ensureStatusColumn();

    const [employees] = await promisePool.query(
      `SELECT
        id,
        full_name,
        phone,
        location,
        position,
        department,
        COALESCE(status, 'Active') as status,
        COALESCE(password, '') as password,
        salary,
        created_at,
        COALESCE(join_date, created_at) as join_date
       FROM employees
       ORDER BY created_at DESC`
    );

    console.log(`Found ${employees.length} employees`);

    res.json({
      success: true,
      employees: employees || []
    });

  } catch (error) {
    console.error("Get employees error:", error);
    console.error("Error details:", error.message);
    res.status(500).json({
      success: false,
      message: "An error occurred while fetching employees",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
});

// Add Employee endpoint
app.post("/api/employees", async (req, res) => {
  try {
    console.log("POST /api/employees");
    await ensureEmployeesTable();
    await ensurePasswordColumn();
    await ensureSalaryColumn();
    await ensureLocationColumn();
    await ensureStatusColumn();

    const {
      name,
      phone,
      location,
      position,
      department,
      status,
      password,
      salary,
      join_date,
      joinDate
    } = req.body;
    const salaryVal = salary != null && salary !== '' ? parseFloat(String(salary).replace(/,/g, '')) : null;
    const statusVal = String(status || 'Active').trim() || 'Active';
    const joinDateVal = (join_date || joinDate || '').trim() || null;

    const locationVal = String(location || '').trim();
    if (!locationVal) {
      return res.status(400).json({
        success: false,
        message: "Location is required (Boma or Geita)"
      });
    }

    // Validation
    if (!name || !phone || !position || !department || !password) {
      return res.status(400).json({
        success: false,
        message: "All required fields must be provided (name, phone, position, department, password)"
      });
    }

    // Ensure password column exists before inserting
    await ensurePasswordColumn();

    // Hash password for security (password_hash column)
    console.log("Hashing password for employee:", name);
    const password_hash = await bcrypt.hash(password, 10);
    console.log("Password hashed successfully");

    const [result] = await promisePool.query(
      `INSERT INTO employees
       (full_name, phone, \`location\`, position, department, status, password_hash, password, salary, join_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURDATE()))`,
      [
        name,
        phone,
        locationVal,
        position,
        department,
        statusVal,
        password_hash,
        password,
        salaryVal,
        joinDateVal
      ]
    );
    console.log("Employee added with plain text password stored");

    const [employees] = await promisePool.query(
      `SELECT
        id,
        full_name,
        phone,
        location,
        position,
        department,
        status,
        password,
        salary,
        created_at,
        join_date
       FROM employees
       WHERE id = ?`,
      [result.insertId]
    );

    res.status(201).json({
      success: true,
      message: "Employee added successfully",
      employee: employees[0]
    });

  } catch (error) {
    console.error("Add employee error:", error);
    res.status(500).json({
      success: false,
      message: "An error occurred while adding employee"
    });
  }
});

// Update Employee endpoint
app.put("/api/employees/:id", async (req, res) => {
  try {
    await ensureEmployeesTable();
    await ensurePasswordColumn();
    await ensureSalaryColumn();
    await ensureLocationColumn();
    await ensureStatusColumn();
    const employeeId = req.params.id;
    console.log(`PUT /api/employees/${employeeId}`);

    const {
      name,
      phone,
      location,
      position,
      department,
      status,
      password,
      salary
    } = req.body;
    const salaryVal = salary != null && salary !== '' ? parseFloat(String(salary).replace(/,/g, '')) : null;
    const locationVal = location != null ? String(location).trim() : null;

    // Validation
    if (!name || !phone || !position || !department) {
      return res.status(400).json({
        success: false,
        message: "All required fields must be provided (name, phone, position, department)"
      });
    }

    // Check if employee exists
    const [existing] = await promisePool.query(
      "SELECT id FROM employees WHERE id = ?",
      [employeeId]
    );

    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Employee not found"
      });
    }

    // Ensure password column exists
    await ensurePasswordColumn();

    let updateQuery;
    let updateValues;

    if (password) {
      const password_hash = await bcrypt.hash(password, 10);
      updateQuery = `UPDATE employees 
                     SET full_name = ?, phone = ?, \`location\` = COALESCE(?, \`location\`), position = ?, 
                         department = ?, status = ?, password_hash = ?, password = ?, salary = ?
                     WHERE id = ?`;
      updateValues = [
        name,
        phone,
        locationVal,
        position,
        department,
        status || "Active",
        password_hash,
        password,
        salaryVal,
        employeeId
      ];
    } else {
      updateQuery = `UPDATE employees 
                     SET full_name = ?, phone = ?, \`location\` = COALESCE(?, \`location\`), position = ?, 
                         department = ?, status = ?, salary = ?
                     WHERE id = ?`;
      updateValues = [
        name,
        phone,
        locationVal,
        position,
        department,
        status || "Active",
        salaryVal,
        employeeId
      ];
    }

    await promisePool.query(updateQuery, updateValues);
    console.log(`Employee ${employeeId} updated successfully`);

    const [employees] = await promisePool.query(
      `SELECT
        id,
        full_name,
        phone,
        location,
        position,
        department,
        password,
        salary,
        created_at,
        join_date
       FROM employees
       WHERE id = ?`,
      [employeeId]
    );

    res.json({
      success: true,
      message: "Employee updated successfully",
      employee: employees[0]
    });

  } catch (error) {
    console.error("Update employee error:", error);
    res.status(500).json({
      success: false,
      message: "An error occurred while updating employee",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
});

// Delete Employee endpoint
app.delete("/api/employees/:id", async (req, res) => {
  try {
    await ensureEmployeesTable();
    const employeeId = req.params.id;
    console.log(`DELETE /api/employees/${employeeId}`);

    // Check if employee exists
    const [existing] = await promisePool.query(
      "SELECT id, full_name FROM employees WHERE id = ?",
      [employeeId]
    );

    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Employee not found"
      });
    }

    // Delete employee from database
    await promisePool.query("DELETE FROM employees WHERE id = ?", [employeeId]);
    console.log(`Employee ${employeeId} deleted successfully`);

    res.json({
      success: true,
      message: "Employee deleted successfully"
    });

  } catch (error) {
    console.error("Delete employee error:", error);
    res.status(500).json({
      success: false,
      message: "An error occurred while deleting employee",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
});

// Tables for admin Categories & Brands forms (form field: name)
async function ensureCategoriesTable() {
  await promisePool.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_name (name),
      INDEX idx_name (name)
    )
  `);
}

async function ensureBrandsTable() {
  await promisePool.query(`
    CREATE TABLE IF NOT EXISTS brands (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_name (name),
      INDEX idx_name (name)
    )
  `);
}

async function ensureSparepartsTable() {
  await ensureCategoriesTable();
  await ensureBrandsTable();
  await promisePool.query(`
    CREATE TABLE IF NOT EXISTS spareparts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      part_name VARCHAR(255) NOT NULL,
      part_number VARCHAR(255) NOT NULL,
      category_id INT NOT NULL,
      brand_id INT NOT NULL,
      quantity_added INT NOT NULL DEFAULT 0,
      soldout_quantity INT NOT NULL DEFAULT 0,
      quantity INT NOT NULL DEFAULT 0,
      wholesale_price DECIMAL(12,2) NULL,
      retail_price DECIMAL(12,2) NULL,
      status VARCHAR(50) DEFAULT 'In Stock',
      location VARCHAR(255) NOT NULL DEFAULT '',
      supplier VARCHAR(255) NULL,
      date_added DATE NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_part_number (part_number),
      INDEX idx_category_id (category_id),
      INDEX idx_brand_id (brand_id),
      INDEX idx_status (status),
      INDEX idx_location (location)
    )
  `);
  // Add price columns if table existed without them
  const [cols] = await promisePool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS 
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'spareparts' AND COLUMN_NAME IN ('wholesale_price', 'retail_price')`
  );
  const hasWholesale = cols.some(c => c.COLUMN_NAME === 'wholesale_price');
  const hasRetail = cols.some(c => c.COLUMN_NAME === 'retail_price');
  if (!hasWholesale) {
    await promisePool.query('ALTER TABLE spareparts ADD COLUMN wholesale_price DECIMAL(12,2) NULL');
  }
  if (!hasRetail) {
    await promisePool.query('ALTER TABLE spareparts ADD COLUMN retail_price DECIMAL(12,2) NULL');
  }

  // Add stock tracking columns if table existed without them
  const [stockCols] = await promisePool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'spareparts' AND COLUMN_NAME IN ('quantity_added', 'soldout_quantity')`
  );
  const hasQuantityAdded = stockCols.some(c => c.COLUMN_NAME === 'quantity_added');
  const hasSoldoutQuantity = stockCols.some(c => c.COLUMN_NAME === 'soldout_quantity');
  if (!hasQuantityAdded) {
    await promisePool.query('ALTER TABLE spareparts ADD COLUMN quantity_added INT NOT NULL DEFAULT 0 AFTER brand_id');
  }
  if (!hasSoldoutQuantity) {
    await promisePool.query('ALTER TABLE spareparts ADD COLUMN soldout_quantity INT NOT NULL DEFAULT 0 AFTER quantity_added');
  }

  // part_number is not unique; duplicate checks use part_number + location in API
  const [partIndexes] = await promisePool.query(
    `SELECT INDEX_NAME, NON_UNIQUE,
            GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'spareparts'
     GROUP BY INDEX_NAME, NON_UNIQUE`
  );
  const uniquePartNumberIndexes = partIndexes.filter(
    (i) =>
      Number(i.NON_UNIQUE) === 0 &&
      i.INDEX_NAME !== 'PRIMARY' &&
      String(i.cols || '').split(',').includes('part_number')
  );
  for (const idx of uniquePartNumberIndexes) {
    console.log(`Removing spareparts unique index: ${idx.INDEX_NAME} (${idx.cols})`);
    await promisePool.query(`ALTER TABLE spareparts DROP INDEX \`${idx.INDEX_NAME}\``);
  }
  const hasPartNumberIndex = partIndexes.some(
    (i) => i.INDEX_NAME === 'idx_part_number' && Number(i.NON_UNIQUE) === 1
  );
  if (!hasPartNumberIndex) {
    await promisePool.query('ALTER TABLE spareparts ADD INDEX idx_part_number (part_number)');
  }
}

// Categories endpoints
// Get all categories
app.get("/api/categories", async (req, res) => {
  try {
    console.log("GET /api/categories - Fetching all categories");
    await ensureCategoriesTable();
    const [categories] = await promisePool.query(
      `SELECT id, name, created_at 
       FROM categories 
       ORDER BY created_at DESC`
    );

    console.log(`Found ${categories.length} categories`);

    res.json({
      success: true,
      categories: categories || []
    });
  } catch (error) {
    console.error("Get categories error:", error);
    res.status(500).json({
      success: false,
      message: "An error occurred while fetching categories",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
});

// Add category
app.post("/api/categories", async (req, res) => {
  try {
    console.log("POST /api/categories");
    await ensureCategoriesTable();
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: "Category name is required"
      });
    }

    // Check if category already exists
    const [existing] = await promisePool.query(
      "SELECT id FROM categories WHERE name = ?",
      [name.trim()]
    );

    if (existing.length > 0) {
      return res.status(409).json({
        success: false,
        message: "Category with this name already exists"
      });
    }

    // Insert category
    const [result] = await promisePool.query(
      `INSERT INTO categories (name) VALUES (?)`,
      [name.trim()]
    );

    console.log(`Category added with ID: ${result.insertId}`);

    // Fetch newly created category
    const [categories] = await promisePool.query(
      `SELECT id, name, created_at 
       FROM categories 
       WHERE id = ?`,
      [result.insertId]
    );

    res.status(201).json({
      success: true,
      message: "Category added successfully",
      category: categories[0]
    });
  } catch (error) {
    console.error("Add category error:", error);
    res.status(500).json({
      success: false,
      message: "An error occurred while adding category",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
});

// Update category
app.put("/api/categories/:id", async (req, res) => {
  try {
    await ensureCategoriesTable();
    const categoryId = req.params.id;
    console.log(`PUT /api/categories/${categoryId}`);
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: "Category name is required"
      });
    }

    // Check if category exists
    const [existing] = await promisePool.query(
      "SELECT id FROM categories WHERE id = ?",
      [categoryId]
    );

    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Category not found"
      });
    }

    // Check if name already exists for another category
    const [nameCheck] = await promisePool.query(
      "SELECT id FROM categories WHERE name = ? AND id != ?",
      [name.trim(), categoryId]
    );

    if (nameCheck.length > 0) {
      return res.status(409).json({
        success: false,
        message: "Category with this name already exists"
      });
    }

    // Update category
    await promisePool.query(
      "UPDATE categories SET name = ? WHERE id = ?",
      [name.trim(), categoryId]
    );

    console.log(`Category ${categoryId} updated successfully`);

    // Fetch updated category
    const [categories] = await promisePool.query(
      `SELECT id, name, created_at 
       FROM categories 
       WHERE id = ?`,
      [categoryId]
    );

    res.json({
      success: true,
      message: "Category updated successfully",
      category: categories[0]
    });
  } catch (error) {
    console.error("Update category error:", error);
    res.status(500).json({
      success: false,
      message: "An error occurred while updating category",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
});

// Delete category
app.delete("/api/categories/:id", async (req, res) => {
  try {
    const categoryId = req.params.id;
    console.log(`DELETE /api/categories/${categoryId}`);

    // Check if category exists
    const [existing] = await promisePool.query(
      "SELECT id, name FROM categories WHERE id = ?",
      [categoryId]
    );

    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Category not found"
      });
    }

    // Delete category
    await promisePool.query("DELETE FROM categories WHERE id = ?", [categoryId]);
    console.log(`Category ${categoryId} deleted successfully`);

    res.json({
      success: true,
      message: "Category deleted successfully"
    });
  } catch (error) {
    console.error("Delete category error:", error);
    res.status(500).json({
      success: false,
      message: "An error occurred while deleting category",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
});

// Brands endpoints
// Get all brands
app.get("/api/brands", async (req, res) => {
  try {
    console.log("GET /api/brands - Fetching all brands");
    await ensureBrandsTable();
    const [brands] = await promisePool.query(
      `SELECT id, name, created_at 
       FROM brands 
       ORDER BY created_at DESC`
    );

    console.log(`Found ${brands.length} brands`);

    res.json({
      success: true,
      brands: brands || []
    });
  } catch (error) {
    console.error("Get brands error:", error);
    res.status(500).json({
      success: false,
      message: "An error occurred while fetching brands",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
});

// Add brand
app.post("/api/brands", async (req, res) => {
  try {
    console.log("POST /api/brands");
    await ensureBrandsTable();
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: "Brand name is required"
      });
    }

    // Check if brand already exists
    const [existing] = await promisePool.query(
      "SELECT id FROM brands WHERE name = ?",
      [name.trim()]
    );

    if (existing.length > 0) {
      return res.status(409).json({
        success: false,
        message: "Brand with this name already exists"
      });
    }

    // Insert brand
    const [result] = await promisePool.query(
      `INSERT INTO brands (name) VALUES (?)`,
      [name.trim()]
    );

    console.log(`Brand added with ID: ${result.insertId}`);

    // Fetch newly created brand
    const [brands] = await promisePool.query(
      `SELECT id, name, created_at 
       FROM brands 
       WHERE id = ?`,
      [result.insertId]
    );

    res.status(201).json({
      success: true,
      message: "Brand added successfully",
      brand: brands[0]
    });
  } catch (error) {
    console.error("Add brand error:", error);
    res.status(500).json({
      success: false,
      message: "An error occurred while adding brand",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
});

// Update brand
app.put("/api/brands/:id", async (req, res) => {
  try {
    const brandId = req.params.id;
    console.log(`PUT /api/brands/${brandId}`);

    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: "Brand name is required"
      });
    }

    // Check if brand exists
    const [existing] = await promisePool.query(
      "SELECT id FROM brands WHERE id = ?",
      [brandId]
    );

    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Brand not found"
      });
    }

    // Check if name already exists for another brand
    const [nameCheck] = await promisePool.query(
      "SELECT id FROM brands WHERE name = ? AND id != ?",
      [name.trim(), brandId]
    );

    if (nameCheck.length > 0) {
      return res.status(409).json({
        success: false,
        message: "Brand with this name already exists"
      });
    }

    // Update brand
    await promisePool.query(
      "UPDATE brands SET name = ? WHERE id = ?",
      [name.trim(), brandId]
    );

    console.log(`Brand ${brandId} updated successfully`);

    // Fetch updated brand
    const [brands] = await promisePool.query(
      `SELECT id, name, created_at 
       FROM brands 
       WHERE id = ?`,
      [brandId]
    );

    res.json({
      success: true,
      message: "Brand updated successfully",
      brand: brands[0]
    });
  } catch (error) {
    console.error("Update brand error:", error);
    res.status(500).json({
      success: false,
      message: "An error occurred while updating brand",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
});

// Delete brand
app.delete("/api/brands/:id", async (req, res) => {
  try {
    await ensureBrandsTable();
    const brandId = req.params.id;
    console.log(`DELETE /api/brands/${brandId}`);
    // Check if brand exists
    const [existing] = await promisePool.query(
      "SELECT id, name FROM brands WHERE id = ?",
      [brandId]
    );

    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Brand not found"
      });
    }

    // Delete brand
    await promisePool.query("DELETE FROM brands WHERE id = ?", [brandId]);
    console.log(`Brand ${brandId} deleted successfully`);

    res.json({
      success: true,
      message: "Brand deleted successfully"
    });
  } catch (error) {
    console.error("Delete brand error:", error);
    res.status(500).json({
      success: false,
      message: "An error occurred while deleting brand",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
});

// Spare Parts endpoints
// Get all spare parts (spareparts table has wholesale_price and retail_price, not unit_price)
app.get("/api/spareparts", async (req, res) => {
  try {
    const branchLoc = normalizeBranchLocation(req.query.location);
    console.log("GET /api/spareparts", branchLoc ? `(location=${branchLoc})` : "(all locations)");
    await ensureSparepartsTable();
    const params = [];
    let whereClause = "";
    if (branchLoc) {
      whereClause = " WHERE LOWER(TRIM(sp.location)) = LOWER(?)";
      params.push(branchLoc);
    }
    const [spareParts] = await promisePool.query(
      `SELECT 
        sp.id,
        sp.part_name,
        sp.part_number,
        sp.category_id,
        c.name AS category_name,
        sp.brand_id,
        b.name AS brand_name,
        sp.quantity_added,
        sp.soldout_quantity,
        sp.quantity,
        sp.wholesale_price,
        sp.retail_price,
        sp.status,
        sp.location,
        sp.supplier,
        sp.date_added,
        sp.created_at,
        sp.updated_at
       FROM spareparts sp
       LEFT JOIN categories c ON sp.category_id = c.id
       LEFT JOIN brands b ON sp.brand_id = b.id
       ${whereClause}
       ORDER BY sp.created_at DESC`,
      params
    );

    console.log(`Found ${spareParts.length} spare parts`);

    res.json({
      success: true,
      spareParts: spareParts || []
    });

  } catch (error) {
    console.error("Get spare parts error:", error);
    res.status(500).json({
      success: false,
      message: "An error occurred while fetching spare parts",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
});

// Add spare part
app.post("/api/spareparts", async (req, res) => {
  try {
    console.log("POST /api/spareparts");
    await ensureSparepartsTable();
    console.log("Request body:", JSON.stringify(req.body, null, 2));
    const {
      part_name,
      part_number,
      category_id,
      brand_id,
      quantity,
      retail_price,
      status,
      location,
      supplier
    } = req.body;
    const stripCommas = (v) => (v == null || v === '' ? null : parseFloat(String(v).replace(/,/g, '')));
    const retailVal = stripCommas(retail_price);
    if (!part_name || !part_number || !category_id || !brand_id || quantity === undefined || (retailVal == null || isNaN(retailVal))) {
      return res.status(400).json({
        success: false,
        message: "All required fields must be provided (part_name, part_number, category_id, brand_id, quantity, retail_price, status, location)"
      });
    }
    if (!status || !location) {
      return res.status(400).json({
        success: false,
        message: "Status and location are required"
      });
    }
    // Same part number allowed when location differs
    const locationTrimmed = location.trim();
    const [existing] = await promisePool.query(
      "SELECT id FROM spareparts WHERE part_number = ? AND location = ?",
      [part_number.trim(), locationTrimmed]
    );
    if (existing.length > 0) {
      return res.status(409).json({
        success: false,
        message: "A spare part with this part number already exists at this location"
      });
    }
    const qtyInt = parseInt(quantity, 10);
    const [result] = await promisePool.query(
      `INSERT INTO spareparts 
       (part_name, part_number, category_id, brand_id, quantity_added, quantity, retail_price, status, location, supplier, date_added)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURDATE())`,
      [
        part_name.trim(),
        part_number.trim(),
        parseInt(category_id),
        parseInt(brand_id),
        qtyInt,
        qtyInt,
        retailVal,
        status,
        location.trim(),
        supplier || 'Thiago Auto Spare'
      ]
    );

    console.log(`Spare part added with ID: ${result.insertId}`);

    // Fetch newly created spare part with category and brand names
    const [spareParts] = await promisePool.query(
      `SELECT 
        sp.id,
        sp.part_name,
        sp.part_number,
        sp.category_id,
        c.name AS category_name,
        sp.brand_id,
        b.name AS brand_name,
        sp.quantity_added,
        sp.soldout_quantity,
        sp.quantity,
        sp.wholesale_price,
        sp.retail_price,
        sp.status,
        sp.location,
        sp.supplier,
        sp.date_added,
        sp.created_at,
        sp.updated_at
       FROM spareparts sp
       LEFT JOIN categories c ON sp.category_id = c.id
       LEFT JOIN brands b ON sp.brand_id = b.id
       WHERE sp.id = ?`,
      [result.insertId]
    );

    res.status(201).json({
      success: true,
      message: "Spare part added successfully",
      sparePart: spareParts[0]
    });

  } catch (error) {
    console.error("Add spare part error:", error);
    console.error("Error details:", error.message);
    console.error("Error stack:", error.stack);
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        success: false,
        message:
          "A spare part with this part number already exists at this location. Restart the backend if you recently updated the database schema."
      });
    }
    res.status(500).json({
      success: false,
      message: error.message || "An error occurred while adding spare part",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
});

// Update spare part
app.put("/api/spareparts/:id", async (req, res) => {
  try {
    console.log(`PUT /api/spareparts/${req.params.id}`);
    await ensureSparepartsTable();
    console.log("Request body:", JSON.stringify(req.body, null, 2));

    const {
      quantity_to_add,
      part_name,
      part_number,
      category_id,
      brand_id,
      quantity,
      wholesale_price,
      retail_price,
      status,
      location,
      supplier
    } = req.body;
    const partId = parseInt(req.params.id);

    if (!partId) {
      return res.status(400).json({
        success: false,
        message: "Part ID is required"
      });
    }

    // Branch 1: quantity-only adjustment (no other fields in body)
    const isQuantityOnlyUpdate =
      quantity_to_add !== undefined &&
      quantity_to_add !== null &&
      quantity_to_add !== '' &&
      part_name === undefined &&
      part_number === undefined &&
      category_id === undefined &&
      brand_id === undefined &&
      quantity === undefined;

    if (isQuantityOnlyUpdate) {
      // Get current spare part
      const [currentParts] = await promisePool.query(
        "SELECT quantity, quantity_added, retail_price FROM spareparts WHERE id = ?",
        [partId]
      );

      if (currentParts.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Spare part not found"
        });
      }

      const currentQuantity = parseInt(currentParts[0].quantity) || 0;
      const currentQtyAdded = parseInt(currentParts[0].quantity_added) || 0;
      const quantityToAdd = parseInt(quantity_to_add) || 0;
      const newQuantity = currentQuantity + quantityToAdd;
      const newQtyAdded = currentQtyAdded + quantityToAdd;

      if (newQuantity < 0) {
        return res.status(400).json({
          success: false,
          message: "Resulting quantity cannot be negative"
        });
      }

      await promisePool.query(
        `UPDATE spareparts 
         SET quantity = ?, quantity_added = ?, updated_at = NOW()
         WHERE id = ?`,
        [newQuantity, newQtyAdded, partId]
      );

      console.log(`Spare part ${partId} updated: quantity ${currentQuantity} + ${quantityToAdd} = ${newQuantity}`);

      // Fetch updated spare part
      const [updatedParts] = await promisePool.query(
        `SELECT 
          sp.id,
          sp.part_name,
          sp.part_number,
          sp.category_id,
          c.name AS category_name,
          sp.brand_id,
          b.name AS brand_name,
          sp.quantity_added,
          sp.soldout_quantity,
          sp.quantity,
          sp.wholesale_price,
          sp.retail_price,
          sp.status,
          sp.location,
          sp.supplier,
          sp.date_added,
          sp.created_at,
          sp.updated_at
         FROM spareparts sp
         LEFT JOIN categories c ON sp.category_id = c.id
         LEFT JOIN brands b ON sp.brand_id = b.id
         WHERE sp.id = ?`,
        [partId]
      );

      return res.json({
        success: true,
        message: "Spare part quantity updated successfully",
        sparePart: updatedParts[0]
      });
    }

    // Branch 2: full row update (edit all main fields)
    if (!part_name || !part_number || !category_id || !brand_id || quantity === undefined) {
      return res.status(400).json({
        success: false,
        message: "part_name, part_number, category_id, brand_id and quantity are required for full update"
      });
    }

    const qtyVal = parseInt(quantity, 10);
    if (Number.isNaN(qtyVal) || qtyVal < 0) {
      return res.status(400).json({
        success: false,
        message: "Quantity must be a non-negative number"
      });
    }

    const wholesaleVal =
      wholesale_price === null || wholesale_price === undefined || wholesale_price === ''
        ? null
        : parseFloat(String(wholesale_price).replace(/,/g, ''));
    const retailVal =
      retail_price === null || retail_price === undefined || retail_price === ''
        ? null
        : parseFloat(String(retail_price).replace(/,/g, ''));

    if (wholesaleVal !== null && (Number.isNaN(wholesaleVal) || wholesaleVal < 0)) {
      return res.status(400).json({
        success: false,
        message: "Wholesale price must be a valid number (≥ 0) if provided"
      });
    }

    if (retailVal !== null && (Number.isNaN(retailVal) || retailVal < 0)) {
      return res.status(400).json({
        success: false,
        message: "Retail price must be a valid number (≥ 0) if provided"
      });
    }

    const statusVal = status && String(status).trim() ? String(status).trim() : 'In Stock';
    const locationVal = location && String(location).trim();

    if (!locationVal) {
      return res.status(400).json({
        success: false,
        message: "Location is required"
      });
    }

    const partNumberTrimmed = String(part_number).trim();
    const [duplicateParts] = await promisePool.query(
      "SELECT id FROM spareparts WHERE part_number = ? AND location = ? AND id != ?",
      [partNumberTrimmed, locationVal, partId]
    );
    if (duplicateParts.length > 0) {
      return res.status(409).json({
        success: false,
        message: "A spare part with this part number already exists at this location"
      });
    }

    const supplierVal =
      supplier && String(supplier).trim()
        ? String(supplier).trim()
        : 'Thiago Auto Spare';

    const [currentParts] = await promisePool.query(
      "SELECT quantity, quantity_added FROM spareparts WHERE id = ?",
      [partId]
    );

    if (currentParts.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Spare part not found"
      });
    }

    const currentQuantity = parseInt(currentParts[0].quantity, 10) || 0;
    const currentQtyAdded = parseInt(currentParts[0].quantity_added, 10) || 0;
    let finalQuantity = qtyVal;
    let finalQtyAdded = currentQtyAdded;

    if (quantity_to_add !== undefined && quantity_to_add !== null && quantity_to_add !== '') {
      const quantityToAdd = parseInt(quantity_to_add, 10) || 0;
      if (quantityToAdd > 0) {
        finalQuantity = currentQuantity + quantityToAdd;
        finalQtyAdded = currentQtyAdded + quantityToAdd;
      } else {
        finalQuantity = currentQuantity;
      }
    }

    await promisePool.query(
      `UPDATE spareparts
       SET part_name = ?, part_number = ?, category_id = ?, brand_id = ?,
           quantity = ?, quantity_added = ?, wholesale_price = ?, retail_price = ?,
           status = ?, location = ?, supplier = ?, updated_at = NOW()
       WHERE id = ?`,
      [
        String(part_name).trim(),
        String(part_number).trim(),
        parseInt(category_id, 10),
        parseInt(brand_id, 10),
        finalQuantity,
        finalQtyAdded,
        wholesaleVal,
        retailVal,
        statusVal,
        locationVal,
        supplierVal,
        partId
      ]
    );

    const [updatedParts] = await promisePool.query(
      `SELECT 
        sp.id,
        sp.part_name,
        sp.part_number,
        sp.category_id,
        c.name AS category_name,
        sp.brand_id,
        b.name AS brand_name,
        sp.quantity_added,
        sp.soldout_quantity,
        sp.quantity,
        sp.wholesale_price,
        sp.retail_price,
        sp.status,
        sp.location,
        sp.supplier,
        sp.date_added,
        sp.created_at,
        sp.updated_at
       FROM spareparts sp
       LEFT JOIN categories c ON sp.category_id = c.id
       LEFT JOIN brands b ON sp.brand_id = b.id
       WHERE sp.id = ?`,
      [partId]
    );

    return res.json({
      success: true,
      message: "Spare part updated successfully",
      sparePart: updatedParts[0]
    });

  } catch (error) {
    console.error("Update spare part error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "An error occurred while updating spare part",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
});

// Delete spare part
app.delete("/api/spareparts/:id", async (req, res) => {
  try {
    await ensureSparepartsTable();
    const partId = req.params.id;
    console.log(`DELETE /api/spareparts/${partId}`);

    // Check if spare part exists
    const [existing] = await promisePool.query(
      "SELECT id, part_name FROM spareparts WHERE id = ?",
      [partId]
    );

    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Spare part not found"
      });
    }

    // Delete spare part
    await promisePool.query("DELETE FROM spareparts WHERE id = ?", [partId]);
    console.log(`Spare part ${partId} deleted successfully`);

    res.json({
      success: true,
      message: "Spare part deleted successfully"
    });
  } catch (error) {
    console.error("Delete spare part error:", error);
    res.status(500).json({
      success: false,
      message: "An error occurred while deleting spare part",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
});

// Payments endpoints

async function ensurePaymentsTable() {
  await promisePool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      customer_id INT NOT NULL,
      employee_id INT NULL,
      sparepart_id INT NULL,
      quantity INT NOT NULL DEFAULT 0,
      price DECIMAL(12,2) NULL,
      total_amount DECIMAL(12,2) NULL,
      discount_amount DECIMAL(12,2) NULL,
      amount_received DECIMAL(12,2) NULL,
      amount_remain DECIMAL(12,2) NULL,
      payment_type VARCHAR(50) NULL,
      cash DECIMAL(12,2) NULL,
      bank_transfer DECIMAL(12,2) NULL,
      airtel_money DECIMAL(12,2) NULL,
      mpesa DECIMAL(12,2) NULL,
      mix_by_yas DECIMAL(12,2) NULL,
      payment_method VARCHAR(50) NULL,
      status VARCHAR(50) DEFAULT 'Pending',
      loan_status VARCHAR(50) NULL,
      \`return\` DECIMAL(12,2) NULL,
      approved_by INT NULL,
      approved_at DATETIME NULL,
      confirmed_by_cashier_id INT NULL,
      items_json TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_customer_id (customer_id),
      INDEX idx_employee_id (employee_id),
      INDEX idx_status (status),
      INDEX idx_created_at (created_at)
    )
  `);
  // Migrate old column name: unit_price -> price first (so "AFTER price" works below)
  try {
    await promisePool.query(`ALTER TABLE payments CHANGE COLUMN unit_price price DECIMAL(12,2) NULL`);
  } catch (e) {
    if (e.code !== "ER_BAD_FIELD_ERROR" && e.errno !== 1054) throw e;
  }
  // Add total_amount column if missing (for existing databases) - no AFTER so it works even if price was unit_price
  try {
    await promisePool.query(`ALTER TABLE payments ADD COLUMN total_amount DECIMAL(12,2) NULL`);
  } catch (e) {
    const isDupColumn = e.errno === 1060 || e.code === 'ER_DUP_FIELDNAME' || (e.message && e.message.includes('Duplicate column'));
    if (!isDupColumn) {
      console.error("ensurePaymentsTable: could not add total_amount column:", e.message);
      throw e;
    }
  }
  // Add discount_amount column if missing
  try {
    await promisePool.query(`ALTER TABLE payments ADD COLUMN discount_amount DECIMAL(12,2) NULL`);
  } catch (e) {
    const isDupColumn = e.errno === 1060 || e.code === 'ER_DUP_FIELDNAME' || (e.message && e.message.includes('Duplicate column'));
    if (!isDupColumn) {
      console.error("ensurePaymentsTable: could not add discount_amount column:", e.message);
      throw e;
    }
  }
  // Add price_type column if missing ('retail' | 'wholesale' - which prices were used for total_amount)
  try {
    await promisePool.query(`ALTER TABLE payments ADD COLUMN price_type VARCHAR(20) NULL`);
  } catch (e) {
    const isDupColumn = e.errno === 1060 || e.code === 'ER_DUP_FIELDNAME' || (e.message && e.message.includes('Duplicate column'));
    if (!isDupColumn) throw e;
  }
  // Add payment_type column if missing (e.g. loan / cash / classification for reporting)
  try {
    await promisePool.query(
      `ALTER TABLE payments ADD COLUMN payment_type VARCHAR(50) NULL AFTER amount_remain`
    );
  } catch (e) {
    const isDupColumn = e.errno === 1060 || e.code === 'ER_DUP_FIELDNAME' || (e.message && e.message.includes('Duplicate column'));
    if (!isDupColumn) {
      console.error("ensurePaymentsTable: could not add payment_type column:", e.message);
      throw e;
    }
  }
  // Per-method amounts (breakdown) — optional; used when recording split payments
  try {
    await promisePool.query(
      `ALTER TABLE payments ADD COLUMN cash DECIMAL(12,2) NULL AFTER payment_type`
    );
  } catch (e) {
    const isDupColumn = e.errno === 1060 || e.code === 'ER_DUP_FIELDNAME' || (e.message && e.message.includes('Duplicate column'));
    if (!isDupColumn) {
      console.error("ensurePaymentsTable: could not add cash column:", e.message);
      throw e;
    }
  }
  try {
    await promisePool.query(
      `ALTER TABLE payments ADD COLUMN bank_transfer DECIMAL(12,2) NULL AFTER cash`
    );
  } catch (e) {
    const isDupColumn = e.errno === 1060 || e.code === 'ER_DUP_FIELDNAME' || (e.message && e.message.includes('Duplicate column'));
    if (!isDupColumn) {
      console.error("ensurePaymentsTable: could not add bank_transfer column:", e.message);
      throw e;
    }
  }
  try {
    await promisePool.query(
      `ALTER TABLE payments ADD COLUMN airtel_money DECIMAL(12,2) NULL AFTER bank_transfer`
    );
  } catch (e) {
    const isDupColumn = e.errno === 1060 || e.code === 'ER_DUP_FIELDNAME' || (e.message && e.message.includes('Duplicate column'));
    if (!isDupColumn) {
      console.error("ensurePaymentsTable: could not add airtel_money column:", e.message);
      throw e;
    }
  }
  try {
    await promisePool.query(
      `ALTER TABLE payments ADD COLUMN mpesa DECIMAL(12,2) NULL AFTER airtel_money`
    );
  } catch (e) {
    const isDupColumn = e.errno === 1060 || e.code === 'ER_DUP_FIELDNAME' || (e.message && e.message.includes('Duplicate column'));
    if (!isDupColumn) {
      console.error("ensurePaymentsTable: could not add mpesa column:", e.message);
      throw e;
    }
  }
  try {
    await promisePool.query(
      `ALTER TABLE payments ADD COLUMN mix_by_yas DECIMAL(12,2) NULL AFTER mpesa`
    );
  } catch (e) {
    const isDupColumn = e.errno === 1060 || e.code === 'ER_DUP_FIELDNAME' || (e.message && e.message.includes('Duplicate column'));
    if (!isDupColumn) {
      console.error("ensurePaymentsTable: could not add mix_by_yas column:", e.message);
      throw e;
    }
  }
  // Return amount (reserved word in MySQL — must be quoted)
  try {
    await promisePool.query(
      `ALTER TABLE payments ADD COLUMN \`return\` DECIMAL(12,2) NULL AFTER status`
    );
  } catch (e) {
    const isDupColumn = e.errno === 1060 || e.code === 'ER_DUP_FIELDNAME' || (e.message && e.message.includes('Duplicate column'));
    if (!isDupColumn) {
      console.error("ensurePaymentsTable: could not add return column:", e.message);
      throw e;
    }
  }
  // Loan status (legacy compatibility for environments using separate loan_status)
  try {
    await promisePool.query(
      `ALTER TABLE payments ADD COLUMN loan_status VARCHAR(50) NULL AFTER status`
    );
  } catch (e) {
    const isDupColumn = e.errno === 1060 || e.code === 'ER_DUP_FIELDNAME' || (e.message && e.message.includes('Duplicate column'));
    if (!isDupColumn) {
      console.error("ensurePaymentsTable: could not add loan_status column:", e.message);
      throw e;
    }
  }
  await ensureTableColumn("payments", "location", "VARCHAR(255) NULL AFTER employee_id");
  try {
    await promisePool.query("ALTER TABLE payments ADD INDEX idx_location (location)");
  } catch (e) {
    const isDup =
      e.errno === 1061 ||
      e.code === "ER_DUP_KEYNAME" ||
      (e.message && e.message.includes("Duplicate key name"));
    if (!isDup) throw e;
  }
  await ensureTableColumn("customers", "location", "VARCHAR(255) NULL AFTER address");
  await ensureTableColumn("loans", "location", "VARCHAR(255) NULL AFTER customer_id");
  await backfillPaymentsLocationFromEmployees();
  await backfillCustomersLocationFromPayments();
  await backfillLoansLocationFromPayments();
}

/** Log each increase to amount_received (installment) for per-day / per-range reporting. */
async function ensurePaymentReceivedEventsTable() {
  await promisePool.query(`
    CREATE TABLE IF NOT EXISTS payment_received_events (
      id INT AUTO_INCREMENT PRIMARY KEY,
      payment_id INT NOT NULL,
      amount DECIMAL(12,2) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_pre_payment (payment_id),
      INDEX idx_pre_created (created_at)
    )
  `);
}

async function ensureLoansTable() {
  await promisePool.query(`
    CREATE TABLE IF NOT EXISTS loans (
      id INT AUTO_INCREMENT PRIMARY KEY,
      payment_id INT NOT NULL,
      customer_id INT NOT NULL,
      customer_name VARCHAR(255) NULL,
      customer_phone VARCHAR(50) NULL,
      spareparts VARCHAR(100) NULL,
      total_amount DECIMAL(12,2) NOT NULL,
      cash DECIMAL(12,2) NULL,
      bank_transfer DECIMAL(12,2) NULL,
      airtel_money DECIMAL(12,2) NULL,
      mpesa DECIMAL(12,2) NULL,
      mix_by_yas DECIMAL(12,2) NULL,
      discount DECIMAL(12,2) NULL,
      amount_received DECIMAL(12,2) NULL DEFAULT 0.00,
      amount_remain DECIMAL(12,2) NOT NULL,
      status VARCHAR(50) DEFAULT 'Approved',
      approved_by INT NULL,
      approved_at DATETIME NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_payment_id (payment_id),
      INDEX idx_customer_id (customer_id),
      INDEX idx_status (status),
      INDEX idx_created_at (created_at)
    )
  `);

  // Ensure additional columns exist even if the table was created earlier.
  const columnsToEnsure = [
    { name: 'spareparts', ddl: 'VARCHAR(100) NULL' },
    { name: 'cash', ddl: 'DECIMAL(12,2) NULL' },
    { name: 'bank_transfer', ddl: 'DECIMAL(12,2) NULL' },
    { name: 'airtel_money', ddl: 'DECIMAL(12,2) NULL' },
    { name: 'mpesa', ddl: 'DECIMAL(12,2) NULL' },
    { name: 'mix_by_yas', ddl: 'DECIMAL(12,2) NULL' },
    { name: 'discount', ddl: 'DECIMAL(12,2) NULL' },
  ];

  for (const col of columnsToEnsure) {
    try {
      await promisePool.query(`ALTER TABLE loans ADD COLUMN ${col.name} ${col.ddl}`);
    } catch (e) {
      const isDupColumn =
        e.errno === 1060 ||
        e.code === 'ER_DUP_FIELDNAME' ||
        (e.message && e.message.includes('Duplicate column'));
      if (!isDupColumn) throw e;
    }
  }

  // Prevent duplicate loan rows for the same payment.
  try {
    await promisePool.query(`ALTER TABLE loans ADD UNIQUE INDEX uk_payment_id (payment_id)`);
  } catch (e) {
    const isDupKeyName =
      e.errno === 1061 ||
      e.code === 'ER_DUP_KEYNAME' ||
      (e.message && e.message.includes('Duplicate key name'));
    if (!isDupKeyName) throw e;
  }

  await ensureTableColumn("loans", "location", "VARCHAR(255) NULL AFTER customer_id");
  try {
    await promisePool.query("ALTER TABLE loans ADD INDEX idx_location (location)");
  } catch (e) {
    const isDup =
      e.errno === 1061 ||
      e.code === "ER_DUP_KEYNAME" ||
      (e.message && e.message.includes("Duplicate key name"));
    if (!isDup) throw e;
  }
}

// Insert (or upsert) a loan row using an existing payment_id
// Does not approve/reject the payment or modify sparepart stock.
app.post("/api/loans/from-payment", async (req, res) => {
  try {
    await ensurePaymentsTable();
    await ensureCustomersTable();
    await ensureLoansTable();

    const {
      payment_id,
      status,
      customer_id: customerIdOverride,
      customer_name: customerNameOverride,
      customer_phone: customerPhoneOverride,
      spareparts: sparepartsOverride,
      total_amount: totalAmountOverride,
      cash: cashOverride,
      bank_transfer: bankTransferOverride,
      airtel_money: airtelMoneyOverride,
      mpesa: mpesaOverride,
      mix_by_yas: mixByYasOverride,
      discount: discountOverride,
      amount_received: amountReceivedOverride,
      amount_remain: amountRemainOverride
    } = req.body;

    if (!payment_id) {
      return res.status(400).json({
        success: false,
        message: "payment_id is required",
      });
    }

    const paymentIdNum = parseInt(payment_id, 10);
    if (!Number.isFinite(paymentIdNum)) {
      return res.status(400).json({
        success: false,
        message: "payment_id must be a valid integer",
      });
    }

    const statusVal = status ? String(status) : "Pending";
    if (!["Pending", "Approved", "Rejected"].includes(statusVal)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status value",
      });
    }

    const toDecOrNull = (v) => {
      if (v === undefined || v === null || v === "") return null;
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : null;
    };

    const [rows] = await promisePool.query(
      `SELECT 
        p.items_json,
        p.sparepart_id,
        p.quantity,
        p.total_amount,
        p.amount_received,
        p.amount_remain,
        p.discount_amount,
        p.cash,
        p.bank_transfer,
        p.airtel_money,
        p.mpesa,
        p.mix_by_yas,
        p.customer_id,
        c.name AS customer_name,
        c.phone AS customer_phone,
        p.location AS payment_location
      FROM payments p
      LEFT JOIN customers c ON c.id = p.customer_id
      WHERE p.id = ?`,
      [paymentIdNum]
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Payment not found",
      });
    }

    const payment = rows[0];

    // Defaults from the selected payment record
    const totalAmountDefault = parseFloat(payment.total_amount) || 0;
    const amountReceivedDefault = parseFloat(payment.amount_received) || 0;
    const existingRemainDefault = payment.amount_remain != null ? parseFloat(payment.amount_remain) : null;
    const amountRemainDefault =
      existingRemainDefault != null && !Number.isNaN(existingRemainDefault)
        ? existingRemainDefault
        : Math.max(0, totalAmountDefault - amountReceivedDefault);

    // spareparts is stored as a comma-separated list of sparepart IDs (best-effort).
    let sparepartsStrDefault = null;
    try {
      if (payment.items_json) {
        const items = JSON.parse(payment.items_json);
        const ids = Array.isArray(items) ? items.map((it) => it?.sparepart_id).filter(Boolean) : [];
        if (ids.length > 0) sparepartsStrDefault = ids.map((x) => String(x)).join(",").slice(0, 100);
      } else if (payment.sparepart_id != null) {
        sparepartsStrDefault = String(payment.sparepart_id).slice(0, 100);
      }
    } catch {
      // ignore parsing errors and keep sparepartsStr null
    }

    const discountAmountDefault = toDecOrNull(payment.discount_amount);
    const cashAmountDefault = toDecOrNull(payment.cash);
    const bankTransferAmountDefault = toDecOrNull(payment.bank_transfer);
    const airtelMoneyAmountDefault = toDecOrNull(payment.airtel_money);
    const mpesaAmountDefault = toDecOrNull(payment.mpesa);
    const yasAmountDefault = toDecOrNull(payment.mix_by_yas);

    // Overrides (when present) - allow manager to manually edit the loan row values
    const customerIdFinal =
      Object.prototype.hasOwnProperty.call(req.body, "customer_id") && customerIdOverride != null && String(customerIdOverride).trim() !== ""
        ? (() => {
            const n = parseInt(customerIdOverride, 10);
            return Number.isFinite(n) ? n : (payment.customer_id || 0);
          })()
        : (payment.customer_id || 0);

    const customerNameFinal =
      Object.prototype.hasOwnProperty.call(req.body, "customer_name")
        ? (() => {
            const cn = customerNameOverride != null ? String(customerNameOverride).trim() : "";
            return cn ? cn.slice(0, 255) : null;
          })()
        : (payment.customer_name || null);

    const customerPhoneFinal =
      Object.prototype.hasOwnProperty.call(req.body, "customer_phone")
        ? (() => {
            const cp = customerPhoneOverride != null ? String(customerPhoneOverride).trim() : "";
            return cp ? cp.slice(0, 50) : null;
          })()
        : (payment.customer_phone || null);

    const sparepartsFinal =
      Object.prototype.hasOwnProperty.call(req.body, "spareparts")
        ? (() => {
            const sp = sparepartsOverride != null ? String(sparepartsOverride).trim() : "";
            return sp ? sp.slice(0, 100) : null;
          })()
        : sparepartsStrDefault;

    const totalAmountFinal =
      Object.prototype.hasOwnProperty.call(req.body, "total_amount")
        ? (() => {
            const n = parseFloat(totalAmountOverride);
            return Number.isFinite(n) ? n : totalAmountDefault;
          })()
        : totalAmountDefault;

    const discountAmountFinal =
      Object.prototype.hasOwnProperty.call(req.body, "discount")
        ? toDecOrNull(discountOverride)
        : discountAmountDefault;

    const cashAmountFinal =
      Object.prototype.hasOwnProperty.call(req.body, "cash") ? toDecOrNull(cashOverride) : cashAmountDefault;
    const bankTransferAmountFinal =
      Object.prototype.hasOwnProperty.call(req.body, "bank_transfer") ? toDecOrNull(bankTransferOverride) : bankTransferAmountDefault;
    const airtelMoneyAmountFinal =
      Object.prototype.hasOwnProperty.call(req.body, "airtel_money") ? toDecOrNull(airtelMoneyOverride) : airtelMoneyAmountDefault;
    const mpesaAmountFinal = Object.prototype.hasOwnProperty.call(req.body, "mpesa") ? toDecOrNull(mpesaOverride) : mpesaAmountDefault;
    const yasAmountFinal = Object.prototype.hasOwnProperty.call(req.body, "mix_by_yas") ? toDecOrNull(mixByYasOverride) : yasAmountDefault;

    const amountReceivedFinal =
      Object.prototype.hasOwnProperty.call(req.body, "amount_received") ? toDecOrNull(amountReceivedOverride) : amountReceivedDefault;

    let amountRemainFinal =
      Object.prototype.hasOwnProperty.call(req.body, "amount_remain") ? toDecOrNull(amountRemainOverride) : amountRemainDefault;
    if (amountRemainFinal == null || Number.isNaN(amountRemainFinal)) {
      const receivedSafe = amountReceivedFinal != null && !Number.isNaN(amountReceivedFinal) ? amountReceivedFinal : 0;
      amountRemainFinal = Math.max(0, totalAmountFinal - receivedSafe);
    }

    if (totalAmountFinal == null || Number.isNaN(totalAmountFinal)) {
      return res.status(400).json({ success: false, message: "total_amount is required" });
    }
    if (amountRemainFinal == null || Number.isNaN(amountRemainFinal)) {
      return res.status(400).json({ success: false, message: "amount_remain is required" });
    }

    const approvedBy = statusVal === "Approved" ? req.body.approved_by ?? null : null;
    const approvedAt = statusVal === "Approved" ? new Date() : null;

    const loanLocation = normalizeBranchLocation(payment.payment_location);

    await promisePool.query(
      `INSERT INTO loans (
        payment_id, customer_id, location, customer_name, customer_phone, spareparts,
        total_amount,
        cash, bank_transfer, airtel_money, mpesa, mix_by_yas,
        discount,
        amount_received, amount_remain,
        status, approved_by, approved_at
      )
      VALUES (?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?
      )
      ON DUPLICATE KEY UPDATE
        customer_id = VALUES(customer_id),
        location = VALUES(location),
        customer_name = VALUES(customer_name),
        customer_phone = VALUES(customer_phone),
        spareparts = VALUES(spareparts),
        total_amount = VALUES(total_amount),
        cash = VALUES(cash),
        bank_transfer = VALUES(bank_transfer),
        airtel_money = VALUES(airtel_money),
        mpesa = VALUES(mpesa),
        mix_by_yas = VALUES(mix_by_yas),
        discount = VALUES(discount),
        amount_received = VALUES(amount_received),
        amount_remain = VALUES(amount_remain),
        status = VALUES(status),
        approved_by = VALUES(approved_by),
        approved_at = VALUES(approved_at)`,
      [
        paymentIdNum,
        customerIdFinal,
        loanLocation,
        customerNameFinal,
        customerPhoneFinal,
        sparepartsFinal,
        totalAmountFinal,
        cashAmountFinal,
        bankTransferAmountFinal,
        airtelMoneyAmountFinal,
        mpesaAmountFinal,
        yasAmountFinal,
        discountAmountFinal,
        amountReceivedFinal != null ? amountReceivedFinal : amountReceivedDefault,
        amountRemainFinal,
        statusVal,
        approvedBy,
        approvedAt,
      ]
    );

    return res.json({
      success: true,
      message: "Loan record inserted/updated successfully",
    });
  } catch (error) {
    console.error("POST /api/loans/from-payment error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "An error occurred while creating the loan",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// Create payments for generated sales
app.post("/api/payments", async (req, res) => {
  try {
    console.log("POST /api/payments - Create payments");
    console.log("Request body:", JSON.stringify(req.body, null, 2));

    const { customer_id, employee_id, payment_method, letters, price_type, items, location } = req.body;

    if (!customer_id || !employee_id || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "customer_id, employee_id and at least one item are required"
      });
    }

    await ensurePaymentsTable();

    const connection = await promisePool.getConnection();

    try {
      await connection.beginTransaction();

      let branchLocation = normalizeBranchLocation(location);
      if (!branchLocation) {
        const [empRows] = await connection.query(
          "SELECT location FROM employees WHERE id = ?",
          [parseInt(employee_id, 10)]
        );
        branchLocation = normalizeBranchLocation(empRows[0]?.location);
      }

      // Total from either wholesale or retail: each item's unit_price is already set by the client (retail or wholesale).
      // Sum (quantity * unit_price) or use item.total_amount per line to get the payment total.
      const totalAmount = items.reduce((sum, item) => {
        const quantity = parseInt(item.quantity, 10) || 1;
        const unit_price = parseFloat(item.unit_price) || 0;
        const item_total = parseFloat(item.total_amount) || (quantity * unit_price);
        return sum + (Number.isFinite(item_total) ? item_total : 0);
      }, 0);

      // Get first item's sparepart_id for the main record (for backward compatibility)
      const firstItem = items[0];
      if (!firstItem || !firstItem.sparepart_id) {
        throw new Error("At least one item with sparepart_id is required");
      }

      // Store items as JSON string for the payment record
      const itemsJson = JSON.stringify(items.map(item => ({
        sparepart_id: item.sparepart_id,
        quantity: item.quantity || 1,
        unit_price: parseFloat(item.unit_price || 0),
        total_amount: parseFloat(item.total_amount || (item.quantity || 1) * parseFloat(item.unit_price || 0))
      })));

      // Calculate total quantity of all items
      const totalQuantity = items.reduce((sum, item) => sum + (parseInt(item.quantity) || 1), 0);

      const totalAmountToInsert = Number.isFinite(totalAmount) ? totalAmount : 0;
      console.log("Payment total_amount to insert:", totalAmountToInsert, "from", items.length, "items");

      // Create a single payment record with all items
      // Use first item's sparepart_id for backward compatibility, but store all items in items_json
      const [result] = await connection.query(
        `INSERT INTO payments 
         (customer_id, employee_id, location, sparepart_id, quantity, price, payment_method, status, approved_by, approved_at, items_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          parseInt(customer_id),
          parseInt(employee_id),
          branchLocation,
          parseInt(firstItem.sparepart_id), // First item's sparepart_id for backward compatibility
          totalQuantity, // Total quantity of all items
          parseFloat(firstItem.unit_price || 0), // First item's price for backward compatibility
          payment_method != null && payment_method !== '' ? payment_method : null, // Do not default; cashier sets when confirming
          "Pending",
          null, // approved_by - NULL initially, set by accountant later
          null, // approved_at - NULL initially, set by accountant later
          itemsJson // Store all items as JSON
        ]
      );

      const insertId = result.insertId;
      // Set total_amount (and price_type when column exists) in a separate UPDATE so they are always stored
      const priceTypeToStore = price_type || 'retail'; // Default to 'retail' if not provided
      try {
        await connection.query(
          `UPDATE payments SET total_amount = ?, price_type = ? WHERE id = ?`,
          [totalAmountToInsert, priceTypeToStore, insertId]
        );
      } catch (updateErr) {
        // If price_type column does not exist yet, set only total_amount
        if (updateErr.code === 'ER_BAD_FIELD_ERROR' || (updateErr.message && updateErr.message.includes('price_type'))) {
          await connection.query(`UPDATE payments SET total_amount = ? WHERE id = ?`, [totalAmountToInsert, insertId]);
        } else throw updateErr;
      }

      await connection.commit();

      console.log(`Created 1 payment record with ${items.length} items for customer ${customer_id}`);

      return res.json({
        success: true,
        message: "Payment created successfully",
        paymentId: result.insertId,
        insertedRows: 1,
        itemsCount: items.length
      });
    } catch (err) {
      await connection.rollback();
      console.error("Error creating payments:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to create payments",
        error: process.env.NODE_ENV === "development" ? err.message : undefined
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error("/api/payments error:", error);
    res.status(500).json({
      success: false,
      message: "An error occurred while creating payments",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
});

// Get all payments
app.get("/api/payments", async (req, res) => {
  try {
    console.log("GET /api/payments - Fetching all payments");
    await ensurePaymentsTable();
    await ensurePaymentReceivedEventsTable();

    const receivedSumFrom = req.query.receivedSumFrom || req.query.received_sum_from || "";
    const receivedSumTo = req.query.receivedSumTo || req.query.received_sum_to || "";
    const branchLoc = normalizeBranchLocation(req.query.location);

    const paymentParams = [];
    let paymentWhere = "";
    if (branchLoc) {
      paymentWhere = " WHERE LOWER(TRIM(p.location)) = LOWER(?)";
      paymentParams.push(branchLoc);
    }

    const [payments] = await promisePool.query(
      `SELECT 
        p.id,
        p.customer_id,
        c.name AS customer_name,
        c.phone AS customer_phone,
        p.employee_id,
        e.full_name AS employee_name,
        p.location,
        p.sparepart_id,
        sp.part_name AS sparepart_name,
        sp.part_number AS sparepart_number,
       p.quantity,
       p.price AS unit_price,
       p.total_amount,
       p.discount_amount,
       p.amount_received,
       p.amount_remain,
       p.payment_type,
       p.cash,
       p.bank_transfer,
       p.airtel_money,
       p.mpesa,
       p.mix_by_yas,
       p.payment_method,
        p.loan_status,
       p.price_type,
       p.status,
       p.\`return\` AS return_amount,
        p.approved_by,
        approver.full_name AS approver_name,
        p.approved_at,
        p.created_at,
        p.updated_at,
        p.items_json
       FROM payments p
       LEFT JOIN customers c ON p.customer_id = c.id
       LEFT JOIN employees e ON p.employee_id = e.id
       LEFT JOIN spareparts sp ON p.sparepart_id = sp.id
       LEFT JOIN employees approver ON p.approved_by = approver.id
       ${paymentWhere}
       ORDER BY p.created_at DESC`,
      paymentParams
    );

    const [todaySumRows] = await promisePool.query(
      `SELECT payment_id, COALESCE(SUM(amount), 0) AS amt
       FROM payment_received_events
       WHERE DATE(created_at) = CURDATE()
       GROUP BY payment_id`
    );
    const todaySumMap = new Map(
      (todaySumRows || []).map((r) => [r.payment_id, parseFloat(r.amt) || 0])
    );

    let rangeSumMap = new Map();
    if (String(receivedSumFrom).trim() && String(receivedSumTo).trim()) {
      const [rangeRows] = await promisePool.query(
        `SELECT payment_id, COALESCE(SUM(amount), 0) AS amt
         FROM payment_received_events
         WHERE DATE(created_at) >= ? AND DATE(created_at) <= ?
         GROUP BY payment_id`,
        [String(receivedSumFrom).trim(), String(receivedSumTo).trim()]
      );
      rangeSumMap = new Map((rangeRows || []).map((r) => [r.payment_id, parseFloat(r.amt) || 0]));
    }

    // Process payments to expand items_json with sparepart names
    const processedPayments = await Promise.all(payments.map(async (payment) => {
      payment.amount_received_today = todaySumMap.get(payment.id) ?? 0;
      if (String(receivedSumFrom).trim() && String(receivedSumTo).trim()) {
        payment.amount_received_in_range = rangeSumMap.get(payment.id) ?? 0;
      }
      if (payment.items_json) {
        try {
          const items = JSON.parse(payment.items_json);
          // Fetch sparepart details for each item
          const itemsWithNames = await Promise.all(items.map(async (item) => {
            const [spareparts] = await promisePool.query(
              `SELECT part_name, part_number FROM spareparts WHERE id = ?`,
              [item.sparepart_id]
            );
            return {
              ...item,
              sparepart_name: spareparts[0]?.part_name || 'Unknown',
              sparepart_number: spareparts[0]?.part_number || 'N/A'
            };
          }));
          payment.items = itemsWithNames;
        } catch (error) {
          console.error('Error parsing items_json:', error);
          payment.items = [];
        }
      }
      return payment;
    }));

    console.log(`Found ${processedPayments.length} payments`);

    res.json({
      success: true,
      payments: processedPayments || []
    });

  } catch (error) {
    console.error("Get payments error:", error);
    res.status(500).json({
      success: false,
      message: "An error occurred while fetching payments",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
});

// Update payment status (approve / reject) - used by Manager; on Approve, reduce sparepart quantities
app.put("/api/payments/:id/status", async (req, res) => {
  try {
    await ensurePaymentsTable();
    await ensureSparepartsTable();
    await ensureCustomersTable();
    const { id } = req.params;
    const { status, approver_id, update_loan_status, payment_type } = req.body;
    const shouldUpdateLoanStatus = update_loan_status === true || String(update_loan_status).toLowerCase() === 'true';
    const paymentTypeVal =
      payment_type != null && String(payment_type).trim() !== ""
        ? String(payment_type).trim().slice(0, 50)
        : null;

    if (!['Approved', 'Rejected', 'Pending'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status value"
      });
    }

    if (!approver_id) {
      return res.status(400).json({
        success: false,
        message: "approver_id is required"
      });
    }

    const connection = await promisePool.getConnection();

    try {
      if (status === 'Approved') {
        const [rows] = await connection.query(
          `SELECT 
             p.items_json,
             p.sparepart_id,
             p.quantity,
             p.total_amount,
             p.amount_received,
             p.amount_remain,
             p.discount_amount,
             p.cash,
             p.bank_transfer,
             p.airtel_money,
             p.mpesa,
             p.mix_by_yas,
             p.customer_id,
             c.name AS customer_name,
             c.phone AS customer_phone
           FROM payments p
           LEFT JOIN customers c ON c.id = p.customer_id
           WHERE p.id = ?`,
          [id]
        );
        if (rows.length === 0) {
          connection.release();
          return res.status(404).json({
            success: false,
            message: "Payment not found"
          });
        }

        const payment = rows[0];
        const totalAmount = parseFloat(payment.total_amount) || 0;
        const amountReceived = parseFloat(payment.amount_received) || 0;
        const existingRemain = payment.amount_remain != null ? parseFloat(payment.amount_remain) : null;
        const amountRemain = (existingRemain != null && !Number.isNaN(existingRemain))
          ? existingRemain
          : (totalAmount - amountReceived);

        const toDecOrNull = (v) => {
          if (v === undefined || v === null || v === '') return null;
          const n = parseFloat(v);
          return Number.isFinite(n) ? n : null;
        };

        const discountAmount = toDecOrNull(payment.discount_amount);
        const cashAmount = toDecOrNull(payment.cash);
        const bankTransferAmount = toDecOrNull(payment.bank_transfer);
        const airtelMoneyAmount = toDecOrNull(payment.airtel_money);
        const mpesaAmount = toDecOrNull(payment.mpesa);
        const yasAmount = toDecOrNull(payment.mix_by_yas);

        console.log("Approve payment -> loan check", {
          payment_id: id,
          totalAmount,
          amountReceived,
          existingRemain,
          amountRemain
        });
        let itemsToDeduct = [];

        if (payment.items_json) {
          try {
            const items = JSON.parse(payment.items_json);
            itemsToDeduct = items.map((item) => ({
              sparepart_id: parseInt(item.sparepart_id),
              quantity: parseInt(item.quantity) || 1
            }));
          } catch (parseErr) {
            connection.release();
            return res.status(400).json({
              success: false,
              message: "Invalid payment items data"
            });
          }
        } else if (payment.sparepart_id) {
          itemsToDeduct = [{
            sparepart_id: parseInt(payment.sparepart_id),
            quantity: parseInt(payment.quantity) || 1
          }];
        }

        const sparepartsStr = itemsToDeduct.length
          ? itemsToDeduct.map((it) => String(it.sparepart_id)).join(',').slice(0, 100)
          : payment.sparepart_id != null
            ? String(payment.sparepart_id).slice(0, 100)
            : null;

        await connection.beginTransaction();

        for (const item of itemsToDeduct) {
          const [sp] = await connection.query(
            `SELECT id, quantity, part_name, part_number FROM spareparts WHERE id = ? FOR UPDATE`,
            [item.sparepart_id]
          );
          if (sp.length === 0) {
            await connection.rollback();
            connection.release();
            return res.status(400).json({
              success: false,
              message: `Spare part not found (ID: ${item.sparepart_id})`
            });
          }
          const row = sp[0];
          const currentQty = parseInt(row.quantity) || 0;
          const deductQty = item.quantity || 1;
          const partLabel = (() => {
            const name = row.part_name != null ? String(row.part_name).trim() : "";
            const num = row.part_number != null ? String(row.part_number).trim() : "";
            if (name && num) return `${name} (${num})`;
            if (name) return name;
            if (num) return num;
            return `ID ${item.sparepart_id}`;
          })();
          if (currentQty < deductQty) {
            await connection.rollback();
            connection.release();
            return res.status(400).json({
              success: false,
              message: `Insufficient stock for ${partLabel} (available: ${currentQty}, required: ${deductQty})`
            });
          }
          // Deduct current stock only; do not modify quantity_added (intake / historical add).
          await connection.query(
            `UPDATE spareparts
             SET quantity = quantity - ?,
                 soldout_quantity = COALESCE(soldout_quantity, 0) + ?,
                 updated_at = NOW()
             WHERE id = ?`,
            [deductQty, deductQty, item.sparepart_id]
          );
        }

        await connection.query(
          `UPDATE payments 
           SET status = ?,
               loan_status = CASE WHEN ? THEN ? ELSE loan_status END,
               approved_by = ?, approved_at = NOW()${paymentTypeVal ? ", payment_type = ?" : ""}
           WHERE id = ?`,
          paymentTypeVal
            ? [status, shouldUpdateLoanStatus, status, approver_id, paymentTypeVal, id]
            : [status, shouldUpdateLoanStatus, status, approver_id, id]
        );

        if (amountRemain > 0) {
          await ensureLoansTable();
          await connection.query(
            `INSERT INTO loans (
              payment_id, customer_id, customer_name, customer_phone, spareparts,
              total_amount,
              cash, bank_transfer, airtel_money, mpesa, mix_by_yas,
              discount,
              amount_received, amount_remain,
              status, approved_by, approved_at
            )
             VALUES (
              ?, ?, ?, ?, ?,
              ?,
              ?, ?, ?, ?, ?,
              ?,
              ?, ?,
              'Approved', ?, NOW()
             )
             ON DUPLICATE KEY UPDATE
               customer_id = VALUES(customer_id),
               customer_name = VALUES(customer_name),
               customer_phone = VALUES(customer_phone),
               spareparts = VALUES(spareparts),
               total_amount = VALUES(total_amount),
               cash = VALUES(cash),
               bank_transfer = VALUES(bank_transfer),
               airtel_money = VALUES(airtel_money),
               mpesa = VALUES(mpesa),
               mix_by_yas = VALUES(mix_by_yas),
               discount = VALUES(discount),
               amount_received = VALUES(amount_received),
               amount_remain = VALUES(amount_remain),
               status = 'Approved',
               approved_by = VALUES(approved_by),
               approved_at = VALUES(approved_at)`,
            [
              id,
              payment.customer_id || 0,
              payment.customer_name || '',
              payment.customer_phone || '',
              sparepartsStr,
              totalAmount,
              cashAmount,
              bankTransferAmount,
              airtelMoneyAmount,
              mpesaAmount,
              yasAmount,
              discountAmount,
              amountReceived,
              amountRemain,
              approver_id
            ]
          );
        }

        await connection.commit();
      } else {
        const [updateResult] = await connection.query(
          `UPDATE payments 
           SET status = ?,
               loan_status = CASE WHEN ? THEN ? ELSE loan_status END,
               approved_by = ?, approved_at = (CASE WHEN ? IN ('Approved', 'Rejected') THEN NOW() ELSE NULL END)
           WHERE id = ?`,
          [status, shouldUpdateLoanStatus, status, approver_id, status, id]
        );
        if (updateResult.affectedRows === 0) {
          connection.release();
          return res.status(404).json({
            success: false,
            message: "Payment not found"
          });
        }
      }

      connection.release();
      return res.json({
        success: true,
        message: `Payment ${status.toLowerCase()} successfully`
      });
    } catch (txError) {
      if (connection) {
        try {
          await connection.rollback();
        } catch (rbErr) {
          console.error("Rollback error:", rbErr);
        }
        connection.release();
      }
      console.error("Update payment status error:", txError);
      return res.status(500).json({
        success: false,
        message: txError.message || "An error occurred while updating payment status",
        error: process.env.NODE_ENV === "development" ? txError.message : undefined
      });
    }
  } catch (error) {
    console.error("Update payment status error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "An error occurred while updating payment status",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
});

// Return payment (cashier): reduce amount_received, mark status returned, restore spareparts stock
app.put("/api/payments/:id/return", async (req, res) => {
  let connection;
  try {
    await ensurePaymentsTable();
    await ensureSparepartsTable();
    const partId = parseInt(req.params.id, 10);
    const returnAmountRaw = req.body?.return_amount;
    const returnAmount = parseFloat(returnAmountRaw);

    if (!partId) {
      return res.status(400).json({
        success: false,
        message: "Payment ID is required"
      });
    }
    if (!Number.isFinite(returnAmount) || returnAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: "return_amount must be greater than 0"
      });
    }

    connection = await promisePool.getConnection();
    await connection.beginTransaction();

    const [rows] = await connection.query(
      `SELECT id, status, amount_received, \`return\` AS return_amount, items_json, sparepart_id, quantity
       FROM payments
       WHERE id = ?
       FOR UPDATE`,
      [partId]
    );

    if (rows.length === 0) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({
        success: false,
        message: "Payment not found"
      });
    }

    const payment = rows[0];
    if (String(payment.status || '').trim().toLowerCase() === 'returned') {
      await connection.rollback();
      connection.release();
      return res.status(400).json({
        success: false,
        message: "This transaction has already been returned"
      });
    }

    const amountReceived = Number(payment.amount_received) || 0;
    const existingReturn = Number(payment.return_amount) || 0;
    if (returnAmount > amountReceived) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({
        success: false,
        message: "Return amount cannot be greater than amount received"
      });
    }

    const newAmountReceived = Math.max(0, amountReceived - returnAmount);
    const newReturnAmount = existingReturn + returnAmount;

    // Restore spareparts quantities and reverse soldout counters
    let itemsToRestore = [];
    if (payment.items_json) {
      try {
        const parsed = JSON.parse(payment.items_json);
        itemsToRestore = (Array.isArray(parsed) ? parsed : []).map((it) => ({
          sparepart_id: parseInt(it.sparepart_id, 10),
          quantity: parseInt(it.quantity, 10) || 0
        }));
      } catch {
        itemsToRestore = [];
      }
    } else if (payment.sparepart_id) {
      itemsToRestore = [{
        sparepart_id: parseInt(payment.sparepart_id, 10),
        quantity: parseInt(payment.quantity, 10) || 0
      }];
    }

    for (const item of itemsToRestore) {
      if (!item.sparepart_id || item.quantity <= 0) continue;
      // Restore stock and soldout counter only; quantity_added unchanged.
      await connection.query(
        `UPDATE spareparts
         SET quantity = quantity + ?,
             soldout_quantity = GREATEST(0, COALESCE(soldout_quantity, 0) - ?),
             updated_at = NOW()
         WHERE id = ?`,
        [item.quantity, item.quantity, item.sparepart_id]
      );
    }

    await connection.query(
      `UPDATE payments
       SET amount_received = ?, \`return\` = ?, status = 'Returned', updated_at = NOW()
       WHERE id = ?`,
      [newAmountReceived, newReturnAmount, partId]
    );

    await connection.commit();
    connection.release();
    return res.json({
      success: true,
      message: "Transaction returned successfully",
      payment: {
        id: partId,
        status: 'Returned',
        amount_received: newAmountReceived,
        return_amount: newReturnAmount
      }
    });
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch {}
      connection.release();
    }
    console.error("Return payment error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "An error occurred while processing return",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
});

// Update payment (quantity, items_json, total_amount)
app.put("/api/payments/:id", async (req, res) => {
  try {
    await ensurePaymentsTable();
    const { id } = req.params;
    const { quantity, items_json, total_amount, discount_amount } = req.body;

    // Check if payment exists
    const [existing] = await promisePool.query(
      "SELECT id FROM payments WHERE id = ?",
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Payment not found"
      });
    }

    // Build update query dynamically based on provided fields
    const updates = [];
    const values = [];

    if (quantity !== undefined) {
      updates.push("quantity = ?");
      values.push(parseInt(quantity));
    }

    if (items_json !== undefined) {
      updates.push("items_json = ?");
      values.push(typeof items_json === 'string' ? items_json : JSON.stringify(items_json));
    }

    if (total_amount !== undefined) {
      updates.push("total_amount = ?");
      values.push(parseFloat(total_amount));
    }

    if (discount_amount !== undefined) {
      updates.push("discount_amount = ?");
      values.push(discount_amount === null ? null : parseFloat(discount_amount));
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No fields to update"
      });
    }

    updates.push("updated_at = NOW()");
    values.push(id);

    await promisePool.query(
      `UPDATE payments SET ${updates.join(", ")} WHERE id = ?`,
      values
    );

    // Fetch updated payment
    const [updated] = await promisePool.query(
      `SELECT 
        p.id,
        p.customer_id,
        c.name AS customer_name,
        c.phone AS customer_phone,
        p.employee_id,
        e.full_name AS employee_name,
        p.sparepart_id,
        sp.part_name AS sparepart_name,
        sp.part_number AS sparepart_number,
       p.quantity,
       p.price AS unit_price,
       p.total_amount,
       p.discount_amount,
       p.amount_received,
       p.amount_remain,
       p.payment_type,
       p.cash,
       p.bank_transfer,
       p.airtel_money,
       p.mpesa,
       p.mix_by_yas,
       p.payment_method,
       p.status,
       p.\`return\` AS return_amount,
        p.approved_by,
        approver.full_name AS approver_name,
        p.approved_at,
        p.created_at,
        p.updated_at,
        p.items_json
       FROM payments p
       LEFT JOIN customers c ON p.customer_id = c.id
       LEFT JOIN employees e ON p.employee_id = e.id
       LEFT JOIN spareparts sp ON p.sparepart_id = sp.id
       LEFT JOIN employees approver ON p.approved_by = approver.id
       WHERE p.id = ?`,
      [id]
    );

    let payment = updated[0];
    if (payment && payment.items_json) {
      try {
        const items = JSON.parse(payment.items_json);
        const itemsWithNames = await Promise.all(items.map(async (item) => {
          const [spareparts] = await promisePool.query(
            `SELECT part_name, part_number FROM spareparts WHERE id = ?`,
            [item.sparepart_id]
          );
          return {
            ...item,
            sparepart_name: spareparts[0]?.part_name || 'Unknown',
            sparepart_number: spareparts[0]?.part_number || 'N/A'
          };
        }));
        payment.items = itemsWithNames;
      } catch (parseErr) {
        console.error("Error parsing items_json:", parseErr);
      }
    }

    res.json({
      success: true,
      message: "Payment updated successfully",
      payment: payment
    });
  } catch (error) {
    console.error("Update payment error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "An error occurred while updating payment",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
});

// Delete a payment (used when a transaction is fully cancelled)
app.delete("/api/payments/:id", async (req, res) => {
  try {
    await ensurePaymentsTable();
    const { id } = req.params;

    const [existing] = await promisePool.query("SELECT id FROM payments WHERE id = ?", [id]);
    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Payment not found"
      });
    }

    await promisePool.query("DELETE FROM payments WHERE id = ?", [id]);

    res.json({
      success: true,
      message: "Payment deleted successfully"
    });
  } catch (error) {
    console.error("Delete payment error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "An error occurred while deleting payment"
    });
  }
});

// Update payment details (amount_received, payment_method, optional per-channel amounts) - cashier confirm
app.put("/api/payments/:id/details", async (req, res) => {
  try {
    await ensurePaymentsTable();
    await ensurePaymentReceivedEventsTable();
    const { id } = req.params;
    const { amount_received, amount_remain, payment_method, confirmed_by_cashier_id, payment_type, sparepart_id } = req.body;

    const [existingRows] = await promisePool.query(
      "SELECT id, amount_received FROM payments WHERE id = ?",
      [id]
    );
    if (existingRows.length === 0) {
      return res.status(404).json({ success: false, message: "Payment not found" });
    }
    const oldAmountReceived = parseFloat(existingRows[0].amount_received) || 0;

    const toDec = (v) => {
      if (v === undefined || v === null || v === "") return null;
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : null;
    };

    const sets = [
      "amount_received = ?",
      "amount_remain = ?",
      "payment_method = ?",
      "confirmed_by_cashier_id = ?",
    ];
    const values = [
      amount_received != null ? parseFloat(amount_received) : null,
      amount_remain != null ? parseFloat(amount_remain) : null,
      payment_method || null,
      confirmed_by_cashier_id != null ? parseInt(confirmed_by_cashier_id) : null,
    ];
    if (Object.prototype.hasOwnProperty.call(req.body, "payment_type")) {
      sets.push("payment_type = ?");
      values.push(
        payment_type != null && String(payment_type).trim() !== ""
          ? String(payment_type).trim().slice(0, 50)
          : null
      );
    }

    // customer_name / customer_phone are not stored on payments (joined from customers); do not UPDATE them here.

    if (Object.prototype.hasOwnProperty.call(req.body, "sparepart_id")) {
      const spId =
        sparepart_id != null && String(sparepart_id).trim() !== ""
          ? parseInt(String(sparepart_id), 10)
          : null;
      sets.push("sparepart_id = ?");
      values.push(Number.isNaN(spId) ? null : spId);
    }

    const breakdownCols = ["cash", "bank_transfer", "airtel_money", "mpesa", "mix_by_yas"];
    for (const col of breakdownCols) {
      if (Object.prototype.hasOwnProperty.call(req.body, col)) {
        sets.push(col + " = ?");
        values.push(toDec(req.body[col]));
      }
    }

    values.push(id);

    await promisePool.query(
      "UPDATE payments SET " + sets.join(", ") + " WHERE id = ?",
      values
    );

    const newAmountReceived =
      amount_received != null && amount_received !== ""
        ? parseFloat(amount_received)
        : oldAmountReceived;
    const deltaReceived =
      Number.isFinite(newAmountReceived) && Number.isFinite(oldAmountReceived)
        ? newAmountReceived - oldAmountReceived
        : 0;
    if (deltaReceived > 0.0001) {
      await promisePool.query(
        "INSERT INTO payment_received_events (payment_id, amount) VALUES (?, ?)",
        [id, deltaReceived]
      );
    }

    res.json({
      success: true,
      message: "Payment details updated. Pending manager approval."
    });
  } catch (error) {
    console.error("Update payment details error:", error);
    const sqlMsg = error && (error.sqlMessage || error.message);
    res.status(500).json({
      success: false,
      message: sqlMsg || "An error occurred while updating payment details",
      error: process.env.NODE_ENV === "development" ? sqlMsg : undefined
    });
  }
});

// ==================== EXPENSES ENDPOINTS ====================

async function ensureExpensesTable() {
  await promisePool.query(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INT AUTO_INCREMENT PRIMARY KEY,
      expense_date DATE NOT NULL,
      description VARCHAR(500) NOT NULL,
      category VARCHAR(100) NOT NULL,
      amount DECIMAL(12,2) NOT NULL,
      status VARCHAR(50) DEFAULT 'Pending',
      added_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_expense_date (expense_date),
      INDEX idx_category (category),
      INDEX idx_status (status)
    )
  `);
}

// Get all expenses
app.get("/api/expenses", async (req, res) => {
  try {
    console.log("GET /api/expenses");
    await ensureExpensesTable();

    const [expenses] = await promisePool.query(
      `SELECT id, expense_date AS date, description, category, amount, status, added_by, created_at, updated_at
       FROM expenses
       ORDER BY expense_date DESC, id DESC`
    );

    res.json({
      success: true,
      expenses: expenses || []
    });
  } catch (error) {
    console.error("Get expenses error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "An error occurred while fetching expenses",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
});

// Create expense
app.post("/api/expenses", async (req, res) => {
  try {
    console.log("POST /api/expenses", req.body);
    await ensureExpensesTable();

    const { date, description, category, amount, status, added_by } = req.body;

    if (!description || !String(description).trim()) {
      return res.status(400).json({
        success: false,
        message: "Description is required"
      });
    }
    if (!category || !String(category).trim()) {
      return res.status(400).json({
        success: false,
        message: "Category is required"
      });
    }
    const amountNum = parseFloat(amount);
    if (Number.isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({
        success: false,
        message: "Amount must be a positive number"
      });
    }

    const expenseDate = date && String(date).trim() ? String(date).trim() : new Date().toISOString().slice(0, 10);
    const statusVal = status === "Paid" ? "Paid" : "Pending";

    const [result] = await promisePool.query(
      `INSERT INTO expenses (expense_date, description, category, amount, status, added_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        expenseDate,
        String(description).trim(),
        String(category).trim(),
        amountNum,
        statusVal,
        added_by != null ? added_by : null
      ]
    );

    console.log("Expense added with ID:", result.insertId);

    const [[newExpense]] = await promisePool.query(
      `SELECT id, expense_date AS date, description, category, amount, status, added_by, created_at, updated_at
       FROM expenses WHERE id = ?`,
      [result.insertId]
    );

    res.status(201).json({
      success: true,
      message: "Expense created",
      expense: newExpense
    });
  } catch (error) {
    console.error("Create expense error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "An error occurred while creating expense",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
});

// Update expense
app.put("/api/expenses/:id", async (req, res) => {
  try {
    await ensureExpensesTable();
    const { id } = req.params;
    const { date, description, category, amount, status } = req.body;

    if (!description || !String(description).trim()) {
      return res.status(400).json({ success: false, message: "Description is required" });
    }
    if (!category || !String(category).trim()) {
      return res.status(400).json({ success: false, message: "Category is required" });
    }
    const amountNum = parseFloat(amount);
    if (Number.isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ success: false, message: "Amount must be a positive number" });
    }

    const expenseDate = date && String(date).trim() ? String(date).trim() : new Date().toISOString().slice(0, 10);
    const statusVal = status === "Paid" ? "Paid" : "Pending";

    const [result] = await promisePool.query(
      `UPDATE expenses SET expense_date = ?, description = ?, category = ?, amount = ?, status = ? WHERE id = ?`,
      [expenseDate, String(description).trim(), String(category).trim(), amountNum, statusVal, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Expense not found" });
    }

    const [[updatedExpense]] = await promisePool.query(
      `SELECT id, expense_date AS date, description, category, amount, status, added_by, created_at, updated_at
       FROM expenses WHERE id = ?`,
      [id]
    );

    res.json({
      success: true,
      message: "Expense updated",
      expense: updatedExpense
    });
  } catch (error) {
    console.error("Update expense error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "An error occurred while updating expense",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
});

// ==================== REVENUES ENDPOINTS ====================

async function ensureRevenuesTable() {
  await promisePool.query(`
    CREATE TABLE IF NOT EXISTS revenues (
      id INT AUTO_INCREMENT PRIMARY KEY,
      revenue_date DATE NOT NULL,
      description VARCHAR(500) NOT NULL,
      category VARCHAR(100) NOT NULL,
      amount DECIMAL(12,2) NOT NULL,
      payment_method VARCHAR(100) NOT NULL DEFAULT 'Cash',
      status VARCHAR(50) DEFAULT 'Pending',
      added_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_revenue_date (revenue_date),
      INDEX idx_category (category),
      INDEX idx_status (status)
    )
  `);

  // Ensure payment_method column exists for revenues
  try {
    const [cols] = await promisePool.query(
      `
        SELECT COUNT(*) AS cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'revenues'
          AND COLUMN_NAME = 'payment_method'
      `
    );
    const exists = (cols && cols[0] && Number(cols[0].cnt) > 0) || false;
    if (!exists) {
      await promisePool.query(`
        ALTER TABLE revenues
        ADD COLUMN payment_method VARCHAR(100) NOT NULL DEFAULT 'Cash' AFTER amount
      `);
    }
  } catch (e) {
    // If the column already exists, ignore; otherwise rethrow
    if (!String(e && e.message).toLowerCase().includes('duplicate column')) {
      throw e;
    }
  }
}

// Get all revenues
app.get("/api/revenues", async (req, res) => {
  try {
    console.log("GET /api/revenues");
    await ensureRevenuesTable();
    const [revenues] = await promisePool.query(
      `SELECT id, revenue_date AS date, description, category, amount, payment_method, status, added_by, created_at, updated_at
       FROM revenues
       ORDER BY revenue_date DESC, id DESC`
    );
    res.json({
      success: true,
      revenues: revenues || []
    });
  } catch (error) {
    console.error("Get revenues error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "An error occurred while fetching revenues",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
});

// Create revenue
app.post("/api/revenues", async (req, res) => {
  try {
    console.log("POST /api/revenues", req.body);
    await ensureRevenuesTable();
    const { date, description, category, amount, status, payment_method, added_by } = req.body;

    if (!description || !String(description).trim()) {
      return res.status(400).json({
        success: false,
        message: "Description is required"
      });
    }
    if (!category || !String(category).trim()) {
      return res.status(400).json({
        success: false,
        message: "Category is required"
      });
    }
    const amountNum = parseFloat(amount);
    if (Number.isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({
        success: false,
        message: "Amount must be a positive number"
      });
    }

    if (!payment_method || !String(payment_method).trim()) {
      return res.status(400).json({
        success: false,
        message: "Payment method is required"
      });
    }

    const revenueDate = date && String(date).trim() ? String(date).trim() : new Date().toISOString().slice(0, 10);
    const statusVal = status === "Received" ? "Received" : "Pending";
    const methodVal = String(payment_method).trim();

    const [result] = await promisePool.query(
      `INSERT INTO revenues (revenue_date, description, category, amount, payment_method, status, added_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        revenueDate,
        String(description).trim(),
        String(category).trim(),
        amountNum,
        methodVal,
        statusVal,
        added_by != null ? added_by : null
      ]
    );

    console.log("Revenue added with ID:", result.insertId);

    const [[newRevenue]] = await promisePool.query(
      `SELECT id, revenue_date AS date, description, category, amount, payment_method, status, added_by, created_at, updated_at
       FROM revenues WHERE id = ?`,
      [result.insertId]
    );

    res.status(201).json({
      success: true,
      message: "Revenue created",
      revenue: newRevenue
    });
  } catch (error) {
    console.error("Create revenue error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "An error occurred while creating revenue",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
});

// Update revenue
app.put("/api/revenues/:id", async (req, res) => {
  try {
    await ensureRevenuesTable();
    const { id } = req.params;
    const { date, description, category, amount, status, payment_method } = req.body;

    if (!description || !String(description).trim()) {
      return res.status(400).json({ success: false, message: "Description is required" });
    }
    if (!category || !String(category).trim()) {
      return res.status(400).json({ success: false, message: "Category is required" });
    }
    const amountNum = parseFloat(amount);
    if (Number.isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ success: false, message: "Amount must be a positive number" });
    }
    if (!payment_method || !String(payment_method).trim()) {
      return res.status(400).json({ success: false, message: "Payment method is required" });
    }

    const revenueDate = date && String(date).trim() ? String(date).trim() : new Date().toISOString().slice(0, 10);
    const statusVal = status === "Received" ? "Received" : "Pending";
    const methodVal = String(payment_method).trim();

    const [result] = await promisePool.query(
      `UPDATE revenues SET revenue_date = ?, description = ?, category = ?, amount = ?, payment_method = ?, status = ? WHERE id = ?`,
      [revenueDate, String(description).trim(), String(category).trim(), amountNum, methodVal, statusVal, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Revenue not found" });
    }

    const [[updatedRevenue]] = await promisePool.query(
      `SELECT id, revenue_date AS date, description, category, amount, payment_method, status, added_by, created_at, updated_at
       FROM revenues WHERE id = ?`,
      [id]
    );

    res.json({
      success: true,
      message: "Revenue updated",
      revenue: updatedRevenue
    });
  } catch (error) {
    console.error("Update revenue error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "An error occurred while updating revenue",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
});

// ==================== INVOICES ENDPOINTS ====================

async function ensureInvoicesTable() {
  await promisePool.query(`
    CREATE TABLE IF NOT EXISTS invoices (
      id INT AUTO_INCREMENT PRIMARY KEY,
      invoice_number VARCHAR(100) NOT NULL,
      invoice_date DATE NOT NULL,
      customer_name VARCHAR(255) NOT NULL,
      description VARCHAR(500) NULL,
      amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      status VARCHAR(50) DEFAULT 'Draft',
      due_date DATE NULL,
      added_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_invoice_number (invoice_number),
      INDEX idx_invoice_date (invoice_date),
      INDEX idx_customer_name (customer_name),
      INDEX idx_status (status),
      INDEX idx_due_date (due_date)
    )
  `);
  try {
    await promisePool.query(`ALTER TABLE invoices ADD COLUMN tin VARCHAR(50) NULL`);
  } catch (e) {
    if (e.errno !== 1060 && e.code !== 'ER_DUP_FIELDNAME') throw e;
  }
  try {
    await promisePool.query(`ALTER TABLE invoices ADD COLUMN items_json TEXT NULL`);
  } catch (e) {
    if (e.errno !== 1060 && e.code !== 'ER_DUP_FIELDNAME') throw e;
  }
}

// Get all invoices
app.get("/api/invoices", async (req, res) => {
  try {
    console.log("GET /api/invoices");
    await ensureInvoicesTable();
    const [invoices] = await promisePool.query(
      `SELECT id, invoice_number, invoice_date AS date, customer_name, description, amount, status, due_date, tin, added_by, created_at, updated_at
       FROM invoices
       ORDER BY invoice_date DESC, id DESC`
    );
    res.json({
      success: true,
      invoices: invoices || []
    });
  } catch (error) {
    console.error("Get invoices error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "An error occurred while fetching invoices",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
});

// Create invoice
app.post("/api/invoices", async (req, res) => {
  try {
    console.log("POST /api/invoices", req.body);
    await ensureInvoicesTable();
    const { invoice_number, date, customer_name, description, amount, status, due_date, tin, items_json, added_by } = req.body;

    if (!invoice_number || !String(invoice_number).trim()) {
      return res.status(400).json({ success: false, message: "Invoice number is required" });
    }
    if (!customer_name || !String(customer_name).trim()) {
      return res.status(400).json({ success: false, message: "Customer name is required" });
    }
    const amountNum = parseFloat(amount);
    if (Number.isNaN(amountNum) || amountNum < 0) {
      return res.status(400).json({ success: false, message: "Amount must be a valid number" });
    }

    const invoiceDate = date && String(date).trim() ? String(date).trim() : new Date().toISOString().slice(0, 10);
    const statusVal = ["Draft", "Sent", "Paid", "Overdue"].includes(status) ? status : "Draft";
    const dueDateVal = due_date && String(due_date).trim() ? String(due_date).trim() : null;

    const tinVal = tin != null && String(tin).trim() ? String(tin).trim() : null;
    const itemsJsonVal = items_json != null && typeof items_json === 'string' ? items_json : (Array.isArray(items_json) ? JSON.stringify(items_json) : null);
    const [result] = await promisePool.query(
      `INSERT INTO invoices (invoice_number, invoice_date, customer_name, description, amount, status, due_date, tin, items_json, added_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        String(invoice_number).trim(),
        invoiceDate,
        String(customer_name).trim(),
        description ? String(description).trim() : null,
        amountNum,
        statusVal,
        dueDateVal,
        tinVal,
        itemsJsonVal,
        added_by != null ? added_by : null
      ]
    );

    const [[newInvoice]] = await promisePool.query(
      `SELECT id, invoice_number, invoice_date AS date, customer_name, description, amount, status, due_date, tin, items_json, added_by, created_at, updated_at
       FROM invoices WHERE id = ?`,
      [result.insertId]
    );

    res.status(201).json({
      success: true,
      message: "Invoice created",
      invoice: newInvoice
    });
  } catch (error) {
    console.error("Create invoice error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "An error occurred while creating invoice",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
});

// Update invoice
app.put("/api/invoices/:id", async (req, res) => {
  try {
    await ensureInvoicesTable();
    const { id } = req.params;
    const { invoice_number, date, customer_name, description, amount, status, due_date, tin, items_json } = req.body;

    if (!invoice_number || !String(invoice_number).trim()) {
      return res.status(400).json({ success: false, message: "Invoice number is required" });
    }
    if (!customer_name || !String(customer_name).trim()) {
      return res.status(400).json({ success: false, message: "Customer name is required" });
    }
    const amountNum = parseFloat(amount);
    if (Number.isNaN(amountNum) || amountNum < 0) {
      return res.status(400).json({ success: false, message: "Amount must be a valid number" });
    }

    const invoiceDate = date && String(date).trim() ? String(date).trim() : new Date().toISOString().slice(0, 10);
    const statusVal = ["Draft", "Sent", "Paid", "Overdue"].includes(status) ? status : "Draft";
    const dueDateVal = due_date && String(due_date).trim() ? String(due_date).trim() : null;

    const tinVal = tin != null && String(tin).trim() ? String(tin).trim() : null;
    let itemsJsonVal = null;
    let itemsJsonInBody = false;
    if (Object.prototype.hasOwnProperty.call(req.body, "items_json")) {
      itemsJsonInBody = true;
      itemsJsonVal =
        items_json != null && typeof items_json === "string"
          ? items_json
          : Array.isArray(items_json)
            ? JSON.stringify(items_json)
            : null;
    }

    const updateSql = itemsJsonInBody
      ? `UPDATE invoices SET invoice_number = ?, invoice_date = ?, customer_name = ?, description = ?, amount = ?, status = ?, due_date = ?, tin = ?, items_json = ? WHERE id = ?`
      : `UPDATE invoices SET invoice_number = ?, invoice_date = ?, customer_name = ?, description = ?, amount = ?, status = ?, due_date = ?, tin = ? WHERE id = ?`;
    const updateParams = itemsJsonInBody
      ? [
          String(invoice_number).trim(),
          invoiceDate,
          String(customer_name).trim(),
          description ? String(description).trim() : null,
          amountNum,
          statusVal,
          dueDateVal,
          tinVal,
          itemsJsonVal,
          id
        ]
      : [
          String(invoice_number).trim(),
          invoiceDate,
          String(customer_name).trim(),
          description ? String(description).trim() : null,
          amountNum,
          statusVal,
          dueDateVal,
          tinVal,
          id
        ];

    const [result] = await promisePool.query(updateSql, updateParams);

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Invoice not found" });
    }

    const [[updatedInvoice]] = await promisePool.query(
      `SELECT id, invoice_number, invoice_date AS date, customer_name, description, amount, status, due_date, tin, items_json, added_by, created_at, updated_at
       FROM invoices WHERE id = ?`,
      [id]
    );

    res.json({
      success: true,
      message: "Invoice updated",
      invoice: updatedInvoice
    });
  } catch (error) {
    console.error("Update invoice error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "An error occurred while updating invoice",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
});

// ==================== SALARIES ENDPOINTS ====================

async function ensureSalariesTable() {
  await promisePool.query(`
    CREATE TABLE IF NOT EXISTS salaries (
      id INT AUTO_INCREMENT PRIMARY KEY,
      employee_id INT NOT NULL,
      period VARCHAR(7) NOT NULL COMMENT 'YYYY-MM',
      amount DECIMAL(12,2) NOT NULL,
      status VARCHAR(50) DEFAULT 'Pending',
      payment_date DATE NULL,
      added_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_employee_id (employee_id),
      INDEX idx_period (period),
      INDEX idx_status (status),
      INDEX idx_payment_date (payment_date)
    )
  `);
}

// Get all salaries (with employee name)
app.get("/api/salaries", async (req, res) => {
  try {
    console.log("GET /api/salaries");
    await ensureSalariesTable();
    const [salaries] = await promisePool.query(
      `SELECT s.id, s.employee_id, e.full_name AS employee_name, s.period, s.amount, s.status, s.payment_date, s.added_by, s.created_at, s.updated_at
       FROM salaries s
       LEFT JOIN employees e ON s.employee_id = e.id
       ORDER BY s.period DESC, s.id DESC`
    );
    res.json({
      success: true,
      salaries: salaries || []
    });
  } catch (error) {
    console.error("Get salaries error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "An error occurred while fetching salaries",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
});

// Create salary
app.post("/api/salaries", async (req, res) => {
  try {
    console.log("POST /api/salaries", req.body);
    await ensureSalariesTable();
    const { employee_id, period, amount, status, payment_date, added_by } = req.body;

    if (!employee_id) {
      return res.status(400).json({ success: false, message: "Employee is required" });
    }
    if (!period || !String(period).trim()) {
      return res.status(400).json({ success: false, message: "Period (YYYY-MM) is required" });
    }
    const amountNum = parseFloat(amount);
    if (Number.isNaN(amountNum) || amountNum < 0) {
      return res.status(400).json({ success: false, message: "Amount must be a valid number" });
    }

    const statusVal = ["Pending", "Paid"].includes(status) ? status : "Pending";
    const paymentDateVal = payment_date && String(payment_date).trim() ? String(payment_date).trim() : null;
    const periodVal = String(period).trim().slice(0, 7);

    const [result] = await promisePool.query(
      `INSERT INTO salaries (employee_id, period, amount, status, payment_date, added_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [parseInt(employee_id), periodVal, amountNum, statusVal, paymentDateVal, added_by != null ? added_by : null]
    );

    const [[newSalary]] = await promisePool.query(
      `SELECT s.id, s.employee_id, e.full_name AS employee_name, s.period, s.amount, s.status, s.payment_date, s.added_by, s.created_at, s.updated_at
       FROM salaries s
       LEFT JOIN employees e ON s.employee_id = e.id
       WHERE s.id = ?`,
      [result.insertId]
    );

    res.status(201).json({
      success: true,
      message: "Salary created",
      salary: newSalary
    });
  } catch (error) {
    console.error("Create salary error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "An error occurred while creating salary",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
});

// Update salary
app.put("/api/salaries/:id", async (req, res) => {
  try {
    await ensureSalariesTable();
    const { id } = req.params;
    const { employee_id, period, amount, status, payment_date } = req.body;

    if (!employee_id) {
      return res.status(400).json({ success: false, message: "Employee is required" });
    }
    if (!period || !String(period).trim()) {
      return res.status(400).json({ success: false, message: "Period (YYYY-MM) is required" });
    }
    const amountNum = parseFloat(amount);
    if (Number.isNaN(amountNum) || amountNum < 0) {
      return res.status(400).json({ success: false, message: "Amount must be a valid number" });
    }

    const statusVal = ["Pending", "Paid"].includes(status) ? status : "Pending";
    const paymentDateVal = payment_date && String(payment_date).trim() ? String(payment_date).trim() : null;
    const periodVal = String(period).trim().slice(0, 7);

    const [result] = await promisePool.query(
      `UPDATE salaries SET employee_id = ?, period = ?, amount = ?, status = ?, payment_date = ? WHERE id = ?`,
      [parseInt(employee_id), periodVal, amountNum, statusVal, paymentDateVal, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Salary not found" });
    }

    const [[updatedSalary]] = await promisePool.query(
      `SELECT s.id, s.employee_id, e.full_name AS employee_name, s.period, s.amount, s.status, s.payment_date, s.added_by, s.created_at, s.updated_at
       FROM salaries s
       LEFT JOIN employees e ON s.employee_id = e.id
       WHERE s.id = ?`,
      [id]
    );

    res.json({
      success: true,
      message: "Salary updated",
      salary: updatedSalary
    });
  } catch (error) {
    console.error("Update salary error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "An error occurred while updating salary",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
});

// ==================== CUSTOMERS ENDPOINTS ====================

async function ensureCustomersTable() {
  await promisePool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      phone VARCHAR(50) NOT NULL,
      address VARCHAR(500) NOT NULL,
      location VARCHAR(255) NULL,
      registered_date DATETIME NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_phone (phone),
      INDEX idx_location (location),
      INDEX idx_created_at (created_at)
    )
  `);
  await ensureTableColumn("customers", "location", "VARCHAR(255) NULL AFTER address");
  try {
    await promisePool.query("ALTER TABLE customers ADD INDEX idx_location (location)");
  } catch (e) {
    const isDup =
      e.errno === 1061 ||
      e.code === "ER_DUP_KEYNAME" ||
      (e.message && e.message.includes("Duplicate key name"));
    if (!isDup) throw e;
  }
}

// Get all customers
app.get("/api/customers", async (req, res) => {
  try {
    const branchLoc = normalizeBranchLocation(req.query.location);
    console.log("GET /api/customers", branchLoc ? `(location=${branchLoc})` : "(all locations)");
    await ensureCustomersTable();
    const params = [];
    let whereClause = "";
    if (branchLoc) {
      whereClause = " WHERE LOWER(TRIM(location)) = LOWER(?)";
      params.push(branchLoc);
    }
    const [customers] = await promisePool.query(
      `SELECT 
        id,
        name,
        phone,
        address,
        location,
        registered_date,
        created_at,
        updated_at
       FROM customers
       ${whereClause}
       ORDER BY created_at DESC`,
      params
    );

    res.json({
      success: true,
      customers: customers
    });
  } catch (error) {
    console.error("Get customers error:", error);
    res.status(500).json({
      success: false,
      message: "An error occurred while fetching customers",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
});

// Add new customer
app.post("/api/customers", async (req, res) => {
  try {
    console.log("POST /api/customers");
    await ensureCustomersTable();
    const { name, phone, address, location } = req.body;

    // Validation
    if (!name || !phone || !address) {
      return res.status(400).json({
        success: false,
        message: "Name, Phone, and Address are required fields"
      });
    }

    const branchLoc = normalizeBranchLocation(location);
    if (!branchLoc) {
      return res.status(400).json({
        success: false,
        message: "Branch location is required (Boma or Geita)"
      });
    }

    // Check if phone already exists at this branch
    const [existing] = await promisePool.query(
      "SELECT id FROM customers WHERE phone = ? AND LOWER(TRIM(location)) = LOWER(?)",
      [phone.trim(), branchLoc]
    );

    if (existing.length > 0) {
      return res.status(409).json({
        success: false,
        message: "Customer with this phone number already exists"
      });
    }

    // Insert customer
    const [result] = await promisePool.query(
      `INSERT INTO customers (name, phone, address, location, registered_date)
       VALUES (?, ?, ?, ?, NOW())`,
      [
        name.trim(),
        phone.trim(),
        address.trim(),
        branchLoc
      ]
    );

    console.log(`Customer added with ID: ${result.insertId}`);

    // Fetch newly created customer
    const [customers] = await promisePool.query(
      `SELECT 
        id,
        name,
        phone,
        address,
        location,
        registered_date,
        created_at,
        updated_at
       FROM customers
       WHERE id = ?`,
      [result.insertId]
    );

    res.status(201).json({
      success: true,
      message: "Customer added successfully",
      customer: customers[0]
    });
  } catch (error) {
    console.error("Add customer error:", error);
    res.status(500).json({
      success: false,
      message: "An error occurred while adding customer",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
});

// Update customer
app.put("/api/customers/:id", async (req, res) => {
  try {
    console.log(`PUT /api/customers/${req.params.id}`);
    await ensureCustomersTable();
    const { id } = req.params;
    const { name, phone, address, paymentMethod } = req.body;

    // Validation
    if (!name || !phone || !address) {
      return res.status(400).json({
        success: false,
        message: "Name, Phone, and Address are required fields"
      });
    }

    // Check if customer exists
    const [existing] = await promisePool.query(
      "SELECT id, location FROM customers WHERE id = ?",
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Customer not found"
      });
    }

    const customerLocation = normalizeBranchLocation(existing[0].location);

    // Check if phone is already used by another customer at the same branch
    const phoneQuery = customerLocation
      ? "SELECT id FROM customers WHERE phone = ? AND id != ? AND LOWER(TRIM(location)) = LOWER(?)"
      : "SELECT id FROM customers WHERE phone = ? AND id != ?";
    const phoneParams = customerLocation
      ? [phone.trim(), id, customerLocation]
      : [phone.trim(), id];
    const [phoneCheck] = await promisePool.query(phoneQuery, phoneParams);

    if (phoneCheck.length > 0) {
      return res.status(409).json({
        success: false,
        message: "Phone number is already registered to another customer"
      });
    }

    // Update customer
    await promisePool.query(
      `UPDATE customers 
       SET name = ?, phone = ?, address = ?
       WHERE id = ?`,
      [
        name.trim(),
        phone.trim(),
        address.trim(),
        id
      ]
    );

    console.log(`Customer updated with ID: ${id}`);

    // Fetch updated customer
    const [customers] = await promisePool.query(
      `SELECT 
        id,
        name,
        phone,
        address,
        location,
        registered_date,
        created_at,
        updated_at
       FROM customers
       WHERE id = ?`,
      [id]
    );

    res.json({
      success: true,
      message: "Customer updated successfully",
      customer: customers[0]
    });
  } catch (error) {
    console.error("Update customer error:", error);
    res.status(500).json({
      success: false,
      message: "An error occurred while updating customer",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
});

// Delete customer
app.delete("/api/customers/:id", async (req, res) => {
  try {
    console.log(`DELETE /api/customers/${req.params.id}`);
    await ensureCustomersTable();
    const { id } = req.params;

    // Check if customer exists
    const [existing] = await promisePool.query(
      "SELECT id, name FROM customers WHERE id = ?",
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Customer not found"
      });
    }

    // Delete customer
    await promisePool.query(
      "DELETE FROM customers WHERE id = ?",
      [id]
    );

    console.log(`Customer deleted with ID: ${id}`);

    res.json({
      success: true,
      message: "Customer deleted successfully"
    });
  } catch (error) {
    console.error("Delete customer error:", error);
    res.status(500).json({
      success: false,
      message: "An error occurred while deleting customer",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
});

// ——— Onfon SMS (Manager bulk SMS) ———
// Docs: https://www.docs.onfonmedia.co.ke/rest/sms/

app.get("/api/sms/config", (req, res) => {
  res.json({
    success: true,
    configured: isOnfonConfigured()
  });
});

/** Combined status for Manager SMS page (config + balance + units label). Always HTTP 200. */
app.get("/api/sms/status", async (req, res) => {
  const configured = isOnfonConfigured();
  if (!configured) {
    return res.json({
      success: true,
      configured: false,
      canSend: false,
      unitsDisplay: "Not configured"
    });
  }
  try {
    const balance = await getOnfonBalance();
    const unitsDisplay =
      formatUnitsDisplay(balance.creditsNumeric, balance.credits) ||
      (balance.success === false ? balance.error || "Balance unavailable" : "—");
    res.json({
      success: true,
      configured: true,
      canSend: true,
      unitsDisplay,
      credits: balance.credits ?? null,
      creditsNumeric: balance.creditsNumeric ?? null,
      balanceSuccess: balance.success !== false
    });
  } catch (error) {
    console.error("GET /api/sms/status error:", error);
    res.json({
      success: true,
      configured: true,
      canSend: true,
      unitsDisplay: "Balance unavailable",
      message: error.message || "Failed to fetch SMS balance"
    });
  }
});

/** Onfon wallet balance → SMS units (GET https://api.onfonmedia.co.ke/v1/sms/Balance) */
app.get("/api/sms/balance", async (req, res) => {
  try {
    const result = await getOnfonBalance();
    const units = result.units ?? result.creditsNumeric ?? null;
    const unitsDisplay =
      result.unitsDisplay ||
      formatUnitsDisplay(units, result.credits) ||
      (result.success === false ? result.error || "Balance unavailable" : null);
    res.json({
      success: result.success !== false && result.configured !== false,
      configured: result.configured !== false && isOnfonBalanceConfigured(),
      canSend: isOnfonConfigured(),
      units,
      credits: result.credits ?? null,
      creditsNumeric: units,
      unitsDisplay: unitsDisplay || (units != null ? formatUnitsDisplay(units, result.credits) : null),
      balanceSuccess: result.success !== false,
      error: result.error || null,
      source: "onfon"
    });
  } catch (error) {
    console.error("GET /api/sms/balance error:", error);
    const balanceReady = isOnfonBalanceConfigured();
    res.json({
      success: false,
      configured: balanceReady,
      canSend: isOnfonConfigured(),
      units: null,
      unitsDisplay: balanceReady ? "Balance unavailable" : "Not configured",
      message: error.message || "Failed to fetch SMS balance"
    });
  }
});

app.get("/api/sms/recipients", async (req, res) => {
  try {
    await ensureCustomersTable();
    await ensureLoansTable();

    const branchLoc = normalizeBranchLocation(req.query.location);
    const params = [];
    let locationFilter = "";
    if (branchLoc) {
      locationFilter = " AND LOWER(TRIM(c.location)) = LOWER(?)";
      params.push(branchLoc);
    }

    const [rows] = await promisePool.query(`
      SELECT
        c.id,
        c.name,
        c.phone,
        COALESCE((
          SELECT MAX(l.amount_remain)
          FROM loans l
          WHERE l.customer_id = c.id
            AND l.status = 'Approved'
            AND l.amount_remain > 0
        ), 0) AS amount_remain,
        CASE
          WHEN EXISTS (
            SELECT 1 FROM loans l
            WHERE l.customer_id = c.id
              AND l.status = 'Approved'
              AND l.amount_remain > 0
          ) THEN 'outstanding'
          WHEN EXISTS (
            SELECT 1 FROM loans l
            WHERE l.customer_id = c.id AND l.status = 'Approved'
          ) THEN 'loan'
          ELSE 'customer'
        END AS \`group\`
      FROM customers c
      WHERE c.phone IS NOT NULL AND TRIM(c.phone) <> ''
      ${locationFilter}
      ORDER BY c.name ASC
    `, params);

    const recipients = rows
      .map((r) => ({
        id: r.id,
        name: r.name,
        phone: r.phone,
        group: r.group,
        amount_remain: parseFloat(r.amount_remain) || 0,
        phoneValid: Boolean(normalizePhoneForOnfon(r.phone))
      }))
      .filter((r) => r.phoneValid);

    res.json({ success: true, recipients });
  } catch (error) {
    console.error("GET /api/sms/recipients error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load SMS recipients"
    });
  }
});

app.post("/api/sms/send-bulk", async (req, res) => {
  try {
    const { message, recipients, campaignName, scheduleAt } = req.body || {};

    if (!message || !String(message).trim()) {
      return res.status(400).json({ success: false, message: "Message is required" });
    }
    if (!Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ success: false, message: "At least one recipient is required" });
    }
    if (!isOnfonConfigured()) {
      return res.status(503).json({
        success: false,
        message:
          "Onfon SMS is not configured on the server. Add ONFON_ACCESS_KEY, ONFON_API_KEY, ONFON_CLIENT_ID, and ONFON_SENDER_ID to thiago/server/.env"
      });
    }

    const result = await sendBulkMessages({
      messageTemplate: String(message).trim(),
      recipients,
      scheduleAt: scheduleAt || null
    });

    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: result.errorDescription || "Failed to send SMS",
        ...result,
        campaignName: campaignName || null
      });
    }

    res.json({
      success: true,
      message: result.scheduled
        ? "SMS campaign scheduled successfully"
        : "Bulk SMS sent successfully",
      campaignName: campaignName || null,
      ...result
    });
  } catch (error) {
    console.error("POST /api/sms/send-bulk error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to send bulk SMS"
    });
  }
});

// API 404 handler (must be after all /api routes)
app.use("/api", (req, res) => {
  res.status(404).json({
    success: false,
    message: `API endpoint ${req.method} ${req.originalUrl} not found`
  });
});

// Production — serve React build (same origin as /api)
const buildPath = path.join(__dirname, "..", "..", "frontend", "ts", "build");
if (!isDev) {
  app.use(express.static(buildPath));
  app.get("*", (req, res) => {
    res.sendFile(path.join(buildPath, "index.html"));
  });
}

// Global error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    message: "Internal server error"
  });
});

// Server start
const PORT = process.env.PORT || 5001;
const DB_NAME = process.env.DB_NAME || "thiago_db";

(async () => {
  try {
    await promisePool.query("SELECT 1");
    await ensureAdminUsernameColumn();
    await ensureSparepartsTable();
    console.log(`Database connected: ${process.env.DB_USER || "root"}@${process.env.DB_HOST || "localhost"}/${DB_NAME}`);
  } catch (error) {
    console.error("\nDatabase connection failed on startup:");
    console.error(`  User: ${process.env.DB_USER || "root"}`);
    console.error(`  Host: ${process.env.DB_HOST || "localhost"}`);
    console.error(`  Database: ${DB_NAME}`);
    console.error(`  Error: ${error.message}`);
    console.error("Check backend/server/.env and that MySQL is running in XAMPP.\n");
  }

  const server = app.listen(PORT, "0.0.0.0", () => {
  console.log("\n========================================");
  console.log(` Backend started (${isDev ? "development" : "production"})`);
  console.log("========================================");
  console.log(` Server URL: http://localhost:${PORT}`);
  console.log(` API Base:   http://localhost:${PORT}/api`);
  if (!isDev) {
    console.log(` App UI:     http://localhost:${PORT}`);
  }
  console.log(` Database:   ${DB_NAME} (user: ${process.env.DB_USER || "root"})`);
  console.log(` CORS:       ${allowedOrigins.join(", ") || "(none)"}`);
  console.log("\n Endpoints:");
  console.log("   GET  /api/test      - Test server connection");
  console.log("   GET  /api/test-db   - Test database connection");
  console.log("   GET  /api/health    - Health check");
  console.log("   POST /api/login     - User login");
  console.log("\n Make sure MySQL is running!");
  console.log("========================================\n");
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`\nPort ${PORT} is already in use.`);
      console.error("Another backend instance is probably still running.");
      console.error("\nWindows — free the port:");
      console.error(`  netstat -ano | findstr :${PORT}`);
      console.error("  taskkill /PID <pid> /F");
      console.error("\nOr stop the other terminal running npm run dev:backend.\n");
      process.exit(1);
    }
    console.error("\nServer failed to start:", error.message);
    process.exit(1);
  });
})();
