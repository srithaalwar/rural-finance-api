import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import pool from '../config/db.js'

const router = Router()

router.post('/login', async (req, res) => {
  const { email, password } = req.body
  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required' })
  }

  const [rows] = await pool.query(
    `SELECT u.id, u.code, u.name, u.email, u.password_hash, u.status, r.name AS role
     FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.email = ?`,
    [email.trim().toLowerCase()]
  )
  const user = rows[0]

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ message: 'Invalid email or password' })
  }
  if (user.status !== 'Active') {
    return res.status(403).json({ message: 'Account is inactive' })
  }
  // if (user.role !== 'Super Admin') {
  //   return res.status(403).json({ message: 'This portal is for Super Admin only' })
  // }

  const token = jwt.sign(
    { id: user.id, name: user.name, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  )
  res.json({
    token,
    user: { id: user.id, code: user.code, name: user.name, email: user.email, role: user.role },
  })
})

export default router