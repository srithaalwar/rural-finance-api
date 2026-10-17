import { Router } from 'express'
import bcrypt from 'bcryptjs'
import pool from '../config/db.js'

const router = Router()
const DEFAULT_PASSWORD = 'Welcome@123'

const SELECT_USERS = `
  SELECT u.id, u.code, u.name, u.email, u.mobile, u.status,
         r.name AS role, COALESCE(b.name, 'Head Office') AS location
  FROM users u
  JOIN roles r ON r.id = u.role_id
  LEFT JOIN branches b ON b.id = u.branch_id
`

// GET /api/users?type=admins | staff   (&role=Clerk optional)
router.get('/', async (req, res) => {
  const { type, role } = req.query
  const where = []
  const params = []

  if (type === 'admins') where.push(`r.name IN ('Super Admin', 'Admin')`)
  if (type === 'staff') where.push(`r.name NOT IN ('Super Admin', 'Admin')`)
  if (role) {
    where.push('r.name = ?')
    params.push(role)
  }

  const sql = `${SELECT_USERS} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY u.id`
  const [rows] = await pool.query(sql, params)
  res.json(rows)
})

router.post('/', async (req, res) => {
  const { name, email, mobile, role, branchId } = req.body

  if (!name?.trim() || !email?.trim()) {
    return res.status(400).json({ message: 'Name and email are required' })
  }
  if (role === 'Super Admin') {
    return res.status(400).json({ message: 'Super Admin cannot be created' })
  }

  const [[roleRow]] = await pool.query(
    'SELECT id, is_hq_role FROM roles WHERE name = ?',
    [role]
  )
  if (!roleRow) return res.status(400).json({ message: 'Unknown role' })

  let branch = null
  if (!roleRow.is_hq_role) {
    if (!branchId) return res.status(400).json({ message: 'Branch is required for this role' })
    const [[b]] = await pool.query('SELECT id FROM branches WHERE id = ?', [branchId])
    if (!b) return res.status(400).json({ message: 'Branch not found' })
    branch = b.id
  }

  const hash = await bcrypt.hash(DEFAULT_PASSWORD, 10)

  try {
    const [ins] = await pool.query(
      `INSERT INTO users (code, name, email, mobile, password_hash, role_id, branch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [`TMP${Date.now()}`, name.trim(), email.trim().toLowerCase(), mobile || null, hash, roleRow.id, branch]
    )
    const code = `U-${String(ins.insertId).padStart(3, '0')}`
    await pool.query('UPDATE users SET code = ? WHERE id = ?', [code, ins.insertId])
    res.status(201).json({ id: ins.insertId, code, message: `${role} added` })
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'A user with this email already exists' })
    }
    throw e
  }
})

router.patch('/:id/toggle', async (req, res) => {
  const [[user]] = await pool.query(
    `SELECT u.id, u.status, r.name AS role
     FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
    [req.params.id]
  )
  if (!user) return res.status(404).json({ message: 'User not found' })
  if (user.role === 'Super Admin') {
    return res.status(403).json({ message: 'Super Admin cannot be deactivated' })
  }

  const next = user.status === 'Active' ? 'Inactive' : 'Active'
  await pool.query('UPDATE users SET status = ? WHERE id = ?', [next, user.id])
  res.json({ id: user.id, status: next })
})

export default router