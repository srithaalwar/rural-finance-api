import bcrypt from 'bcryptjs'
import pool from './config/db.js'

const ROLES = [
  ['Super Admin', 'Full access to everything', 1],
  ['Admin', 'Runs daily administration for the head office', 1],
  ['General Manager', 'Oversees all branches and approvals', 1],
  ['Branch Manager', 'Runs one branch', 0],
  ['Clerk', 'Data entry in a branch', 0],
  ['Cashier', 'Handles cash in a branch', 0],
  ['Sales Officer', 'Field sales and customer acquisition', 0],
]

const GROUPS = {
  Masters: ['View Masters', 'Manage Masters'],
  Customers: ['View Customers', 'Create Customers', 'Edit Customers'],
  Deposits: ['Open Deposit', 'Close Deposit', 'Cash Receipt'],
  Loans: ['Loan Application', 'Approve Loan', 'Disburse Loan', 'Loan Receipt'],
  Accounts: ['Journal Entry', 'Cash Payment', 'Bank Entry'],
  Reports: ['View Reports', 'Export Reports'],
  Administration: ['Manage Branches', 'Manage Staff', 'Manage Roles', 'Manage Admins'],
}
const ALL = Object.values(GROUPS).flat()

const ROLE_PERMS = {
  'Super Admin': ALL,
  'Admin': ALL.filter((p) => !['Manage Admins', 'Manage Roles'].includes(p)),
  'General Manager': ['View Masters', 'View Customers', 'Approve Loan', 'Loan Application', 'View Reports', 'Export Reports', 'Journal Entry'],
  'Branch Manager': ['View Masters', 'View Customers', 'Create Customers', 'Edit Customers', 'Open Deposit', 'Close Deposit', 'Loan Application', 'Approve Loan', 'Disburse Loan', 'View Reports', 'Manage Staff'],
  'Clerk': ['View Customers', 'Create Customers', 'Open Deposit', 'Loan Application', 'Journal Entry'],
  'Cashier': ['View Customers', 'Cash Receipt', 'Loan Receipt', 'Cash Payment'],
  'Sales Officer': ['View Customers', 'Create Customers', 'Loan Application', 'View Reports'],
}

const BRANCHES = [
  ['BR-01', 'Rampur Branch', 'Rampur', 'Rangareddy', '2022-03-15'],
  ['BR-02', 'Kondapur Branch', 'Kondapur', 'Sangareddy', '2022-08-02'],
  ['BR-03', 'Shankarpally Branch', 'Shankarpally', 'Rangareddy', '2023-01-10'],
  ['BR-04', 'Medchal Branch', 'Medchal', 'Medchal', '2023-06-21'],
]

// name, email prefix, mobile, role, branch code (null = Head Office), status
const USERS = [
  ['Srithajana', 'srithajana', '98480 00001', 'Super Admin', null, 'Active'],
  ['Arjun Mehta', 'arjun', '98480 00002', 'Admin', null, 'Active'],
  ['Divya Nair', 'divya', '98480 00003', 'Admin', null, 'Active'],
  ['Karan Shah', 'karan', '98480 00004', 'General Manager', null, 'Active'],
  ['Ravi Kumar', 'ravi', '98490 11223', 'Branch Manager', 'BR-01', 'Active'],
  ['Anita Reddy', 'anita', '98490 44556', 'Branch Manager', 'BR-02', 'Active'],
  ['Lata Devi', 'lata', '98490 55667', 'Clerk', 'BR-01', 'Active'],
  ['Suresh Goud', 'suresh', '98490 77889', 'Cashier', 'BR-03', 'Active'],
  ['Meena Rao', 'meena', '98490 99001', 'Sales Officer', 'BR-04', 'Active'],
  ['Prakash Rao', 'prakash', '98490 22334', 'Sales Officer', 'BR-02', 'Inactive'],
]

const conn = await pool.getConnection()
try {
  await conn.query('SET FOREIGN_KEY_CHECKS = 0')
  for (const t of ['role_permissions', 'users', 'permissions', 'roles', 'branches', 'head_office']) {
    await conn.query(`TRUNCATE TABLE ${t}`)
  }
  await conn.query('SET FOREIGN_KEY_CHECKS = 1')

  const roleId = {}
  for (const [name, desc, hq] of ROLES) {
    const [r] = await conn.query('INSERT INTO roles (name, description, is_hq_role) VALUES (?, ?, ?)', [name, desc, hq])
    roleId[name] = r.insertId
  }

  const permId = {}
  for (const [group, list] of Object.entries(GROUPS)) {
    for (const name of list) {
      const [r] = await conn.query('INSERT INTO permissions (name, group_name) VALUES (?, ?)', [name, group])
      permId[name] = r.insertId
    }
  }

  const links = []
  for (const [role, list] of Object.entries(ROLE_PERMS)) {
    for (const p of list) links.push([roleId[role], permId[p]])
  }
  await conn.query('INSERT INTO role_permissions (role_id, permission_id) VALUES ?', [links])

  await conn.query(
    `INSERT INTO head_office (code, name, address, district, state, opened_on)
     VALUES ('HO-001', 'Head Office', 'Plot 12, Banjara Hills, Hyderabad', 'Hyderabad', 'Telangana', '2020-01-01')`
  )

  const branchId = {}
  for (const [code, name, area, district, opened] of BRANCHES) {
    const [r] = await conn.query(
      'INSERT INTO branches (code, name, area, district, opened_on) VALUES (?, ?, ?, ?, ?)',
      [code, name, area, district, opened]
    )
    branchId[code] = r.insertId
  }

  const hash = await bcrypt.hash('Admin@123', 10)
  for (const [i, [name, mail, mobile, role, branch, status]] of USERS.entries()) {
    await conn.query(
      `INSERT INTO users (code, name, email, mobile, password_hash, role_id, branch_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `U-${String(i + 1).padStart(3, '0')}`, name, `${mail}@ruralfinance.bank`, mobile,
        hash, roleId[role], branch ? branchId[branch] : null, status,
      ]
    )
  }

  console.log('Database seeded.')
  console.log('Login: srithajana@ruralfinance.bank / Admin@123')
} finally {
  conn.release()
  await pool.end()
}