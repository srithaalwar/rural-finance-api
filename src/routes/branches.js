import { Router } from 'express'
import pool from '../config/db.js'

const router = Router()

router.get('/', async (req, res) => {
  const [rows] = await pool.query(`
    SELECT b.id, b.code, b.name, b.area, b.district, b.status,
           DATE_FORMAT(b.opened_on, '%d %b %Y') AS opened,
           (SELECT COUNT(*) FROM users u WHERE u.branch_id = b.id) AS staff
    FROM branches b ORDER BY b.id
  `)
  res.json(rows)
})

router.post('/', async (req, res) => {
  const { name, area, district } = req.body
  if (!name?.trim()) return res.status(400).json({ message: 'Branch name is required' })

  const [ins] = await pool.query(
    'INSERT INTO branches (code, name, area, district, opened_on) VALUES (?, ?, ?, ?, CURDATE())',
    [`TMP${Date.now()}`, name.trim(), area || null, district || null]
  )
  const code = `BR-${String(ins.insertId).padStart(2, '0')}`
  await pool.query('UPDATE branches SET code = ? WHERE id = ?', [code, ins.insertId])

  res.status(201).json({ id: ins.insertId, code, message: 'Branch created under Head Office' })
})

export default router