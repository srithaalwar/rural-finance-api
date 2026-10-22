import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import pool from './config/db.js'
import { requireAuth, requireSuperAdmin } from './middleware/auth.js'
import authRoutes from './routes/auth.js'
import dashboardRoutes from './routes/dashboard.js'
import headOfficeRoutes from './routes/headOffice.js'
import branchRoutes from './routes/branches.js'
import userRoutes from './routes/users.js'
import roleRoutes from './routes/roles.js'

const app = express()


app.use(cors({
  origin: 'http://localhost:5173',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}))

app.use(express.json())

// Public routes
app.get('/api/health', async (req, res) => {
  await pool.query('SELECT 1')
  res.json({ status: 'ok', database: 'connected' })
})
app.use('/api/auth', authRoutes)

// Everything below needs a valid Super Admin token
app.use('/api', requireAuth, requireSuperAdmin)
app.use('/api/dashboard', dashboardRoutes)
app.use('/api/head-office', headOfficeRoutes)
app.use('/api/branches', branchRoutes)
app.use('/api/users', userRoutes)
app.use('/api/roles', roleRoutes)

app.use((req, res) => res.status(404).json({ message: 'Route not found' }))

app.use((err, req, res, next) => {
  console.error(err)
  res.status(500).json({ message: 'Server error' })
})

const PORT = process.env.PORT || 5000
app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`))