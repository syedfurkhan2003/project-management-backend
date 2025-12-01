import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import multer, { StorageEngine, FileFilterCallback } from "multer";
import path from "path";
import fs from "fs";
import { 
  registerUserSchema, 
  loginUserSchema,
  insertProjectSchema,
  updateProjectSchema,
  insertTaskSchema,
  updateTaskSchema,
  inviteMemberSchema,
  updateMemberRoleSchema,
  insertTaskCommentSchema,
  updateTaskCommentSchema
} from "@shared/schema";
import { z } from "zod";

const JWT_SECRET = process.env.SESSION_SECRET || "your-super-secret-jwt-key-change-in-production";

const uploadDir = "./uploads";
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req: Express.Request, file: Express.Multer.File, cb: (error: Error | null, destination: string) => void) => {
      cb(null, uploadDir);
    },
    filename: (req: Express.Request, file: Express.Multer.File, cb: (error: Error | null, filename: string) => void) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(null, uniqueSuffix + path.extname(file.originalname));
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

interface AuthRequest extends Request {
  userId?: string;
  file?: Express.Multer.File;
}

function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Authentication required" });
  }

  const token = authHeader.split(" ")[1];
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };
    req.userId = decoded.userId;
    next();
  } catch (error) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  
  app.post("/api/auth/register", async (req: Request, res: Response) => {
    try {
      const validatedData = registerUserSchema.parse(req.body);
      
      const existingEmail = await storage.getUserByEmail(validatedData.email);
      if (existingEmail) {
        return res.status(400).json({ message: "Email already registered" });
      }

      const existingUsername = await storage.getUserByUsername(validatedData.username);
      if (existingUsername) {
        return res.status(400).json({ message: "Username already taken" });
      }

      const hashedPassword = await bcrypt.hash(validatedData.password, 10);
      
      const user = await storage.createUser({
        username: validatedData.username,
        email: validatedData.email,
        password: hashedPassword,
      });

      const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: "7d" });

      res.status(201).json({
        token,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: error.errors[0].message });
      }
      console.error("Registration error:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  app.post("/api/auth/login", async (req: Request, res: Response) => {
    try {
      const validatedData = loginUserSchema.parse(req.body);
      
      const user = await storage.getUserByEmail(validatedData.email);
      if (!user) {
        return res.status(401).json({ message: "Invalid email or password" });
      }

      const validPassword = await bcrypt.compare(validatedData.password, user.password);
      if (!validPassword) {
        return res.status(401).json({ message: "Invalid email or password" });
      }

      const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: "7d" });

      res.json({
        token,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: error.errors[0].message });
      }
      console.error("Login error:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  app.get("/api/auth/me", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
      const user = await storage.getUser(req.userId!);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      
      res.json({
        id: user.id,
        username: user.username,
        email: user.email,
      });
    } catch (error) {
      console.error("Get user error:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  app.get("/api/invitations", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
      const user = await storage.getUser(req.userId!);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      
      const invitations = await storage.getPendingInvitationsForUser(user.email);
      res.json(invitations);
    } catch (error) {
      console.error("Get invitations error:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  app.post("/api/invitations/:id/accept", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
      const accepted = await storage.acceptInvitation(req.params.id, req.userId!);
      if (!accepted) {
        return res.status(404).json({ message: "Invitation not found or already processed" });
      }
      res.json({ message: "Invitation accepted" });
    } catch (error) {
      console.error("Accept invitation error:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  app.post("/api/invitations/:id/decline", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
      const declined = await storage.declineInvitation(req.params.id);
      if (!declined) {
        return res.status(404).json({ message: "Invitation not found" });
      }
      res.json({ message: "Invitation declined" });
    } catch (error) {
      console.error("Decline invitation error:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  app.get("/api/projects", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
      const projects = await storage.getProjects(req.userId!);
      
      const projectsWithTasks = await Promise.all(
        projects.map(async (project) => {
          const tasks = await storage.getTasks(project.id, req.userId!);
          return { ...project, tasks };
        })
      );
      
      res.json(projectsWithTasks);
    } catch (error) {
      console.error("Get projects error:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  app.get("/api/projects/:id", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
      const access = await storage.getProjectWithAccess(req.params.id, req.userId!);
      if (!access) {
        return res.status(404).json({ message: "Project not found" });
      }
      
      const tasks = await storage.getTasks(access.project.id, req.userId!);
      const members = await storage.getProjectMembers(access.project.id);
      const owner = await storage.getUser(access.project.userId);
      
      res.json({ 
        ...access.project, 
        tasks, 
        members,
        owner: owner ? { id: owner.id, username: owner.username, email: owner.email } : null,
        userRole: access.role 
      });
    } catch (error) {
      console.error("Get project error:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  app.post("/api/projects", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
      const validatedData = insertProjectSchema.parse(req.body);
      
      const project = await storage.createProject({
        ...validatedData,
        userId: req.userId!,
      });
      
      await storage.createActivityLog(project.id, req.userId!, "created_project", undefined, `Created project "${project.name}"`);
      
      const user = await storage.getUser(req.userId!);
      const ownerInfo = user ? { id: user.id, username: user.username, email: user.email } : null;
      
      res.status(201).json({ 
        ...project, 
        tasks: [], 
        members: [],
        owner: ownerInfo,
        userRole: "owner" 
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: error.errors[0].message });
      }
      console.error("Create project error:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  app.put("/api/projects/:id", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
      const validatedData = updateProjectSchema.parse(req.body);
      
      const project = await storage.updateProject(req.params.id, req.userId!, validatedData);
      if (!project) {
        return res.status(404).json({ message: "Project not found or no permission" });
      }
      
      await storage.createActivityLog(project.id, req.userId!, "updated_project", undefined, "Updated project details");
      
      const tasks = await storage.getTasks(project.id, req.userId!);
      res.json({ ...project, tasks });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: error.errors[0].message });
      }
      console.error("Update project error:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  app.delete("/api/projects/:id", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
      const deleted = await storage.deleteProject(req.params.id, req.userId!);
      if (!deleted) {
        return res.status(404).json({ message: "Project not found or no permission" });
      }
      
      res.json({ message: "Project deleted successfully" });
    } catch (error) {
      console.error("Delete project error:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  app.get("/api/projects/:projectId/members", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
      const access = await storage.getProjectWithAccess(req.params.projectId, req.userId!);
      if (!access) {
        return res.status(404).json({ message: "Project not found" });
      }
      
      const members = await storage.getProjectMembers(req.params.projectId);
      const invitations = await storage.getProjectInvitations(req.params.projectId);
      
      const owner = await storage.getUser(access.project.userId);
      
      res.json({ 
        members, 
        invitations,
        owner: owner ? { id: owner.id, username: owner.username, email: owner.email } : null
      });
    } catch (error) {
      console.error("Get members error:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  app.post("/api/projects/:projectId/members/invite", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
      const access = await storage.getProjectWithAccess(req.params.projectId, req.userId!);
      if (!access || (access.role !== "owner" && access.role !== "admin")) {
        return res.status(403).json({ message: "No permission to invite members" });
      }
      
      const validatedData = inviteMemberSchema.parse(req.body);
      
      const existingUser = await storage.getUserByEmail(validatedData.email);
      if (existingUser) {
        const existingMember = (await storage.getProjectMembers(req.params.projectId))
          .find(m => m.userId === existingUser.id);
        
        if (existingMember || access.project.userId === existingUser.id) {
          return res.status(400).json({ message: "User is already a member of this project" });
        }
      }
      
      const invitation = await storage.createInvitation(
        req.params.projectId,
        validatedData.email,
        validatedData.role as any,
        req.userId!
      );
      
      await storage.createActivityLog(
        req.params.projectId, 
        req.userId!, 
        "invited_member", 
        undefined, 
        `Invited ${validatedData.email} as ${validatedData.role}`
      );
      
      res.status(201).json(invitation);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: error.errors[0].message });
      }
      console.error("Invite member error:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  app.put("/api/projects/:projectId/members/:memberId", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
      const access = await storage.getProjectWithAccess(req.params.projectId, req.userId!);
      if (!access || (access.role !== "owner" && access.role !== "admin")) {
        return res.status(403).json({ message: "No permission to update members" });
      }
      
      const validatedData = updateMemberRoleSchema.parse(req.body);
      
      const member = await storage.updateMemberRole(
        req.params.projectId,
        req.params.memberId,
        validatedData.role as any
      );
      
      if (!member) {
        return res.status(404).json({ message: "Member not found" });
      }
      
      res.json(member);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: error.errors[0].message });
      }
      console.error("Update member error:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  app.delete("/api/projects/:projectId/members/:memberId", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
      const access = await storage.getProjectWithAccess(req.params.projectId, req.userId!);
      if (!access || (access.role !== "owner" && access.role !== "admin")) {
        return res.status(403).json({ message: "No permission to remove members" });
      }
      
      const removed = await storage.removeMember(req.params.projectId, req.params.memberId);
      if (!removed) {
        return res.status(404).json({ message: "Member not found" });
      }
      
      res.json({ message: "Member removed successfully" });
    } catch (error) {
      console.error("Remove member error:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  app.get("/api/projects/:projectId/activity", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
      const access = await storage.getProjectWithAccess(req.params.projectId, req.userId!);
      if (!access) {
        return res.status(404).json({ message: "Project not found" });
      }
      
      const limit = parseInt(req.query.limit as string) || 50;
      const logs = await storage.getProjectActivityLogs(req.params.projectId, limit);
      
      res.json(logs);
    } catch (error) {
      console.error("Get activity error:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  app.get("/api/projects/:projectId/tasks", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
      const access = await storage.getProjectWithAccess(req.params.projectId, req.userId!);
      if (!access) {
        return res.status(404).json({ message: "Project not found" });
      }
      
      const tasks = await storage.getTasks(req.params.projectId, req.userId!);
      res.json(tasks);
    } catch (error) {
      console.error("Get tasks error:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  app.get("/api/projects/:projectId/tasks/:taskId", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
      const task = await storage.getTask(req.params.taskId, req.params.projectId, req.userId!);
      if (!task) {
        return res.status(404).json({ message: "Task not found" });
      }
      
      const comments = await storage.getTaskComments(req.params.taskId);
      const attachments = await storage.getTaskAttachments(req.params.taskId);
      
      let assignee = null;
      if (task.assigneeId) {
        const user = await storage.getUser(task.assigneeId);
        if (user) {
          assignee = { id: user.id, username: user.username, email: user.email };
        }
      }
      
      res.json({ ...task, comments, attachments, assignee });
    } catch (error) {
      console.error("Get task error:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  app.post("/api/projects/:projectId/tasks", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
      const validatedData = insertTaskSchema.parse(req.body);
      
      const task = await storage.createTask(
        { ...validatedData, projectId: req.params.projectId },
        req.userId!
      );
      
      if (!task) {
        return res.status(404).json({ message: "Project not found or no permission" });
      }
      
      await storage.createActivityLog(
        req.params.projectId, 
        req.userId!, 
        "created_task", 
        task.id, 
        `Created task "${task.title}"`
      );
      
      res.status(201).json(task);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: error.errors[0].message });
      }
      console.error("Create task error:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  app.put("/api/projects/:projectId/tasks/:taskId", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
      const validatedData = updateTaskSchema.parse(req.body);
      
      const existingTask = await storage.getTask(req.params.taskId, req.params.projectId, req.userId!);
      
      const task = await storage.updateTask(
        req.params.taskId,
        req.params.projectId,
        req.userId!,
        validatedData
      );
      
      if (!task) {
        return res.status(404).json({ message: "Task not found or no permission" });
      }
      
      let activityDetails = "Updated task";
      if (existingTask && validatedData.status && existingTask.status !== validatedData.status) {
        activityDetails = `Changed status from "${existingTask.status}" to "${validatedData.status}"`;
      }
      
      await storage.createActivityLog(
        req.params.projectId, 
        req.userId!, 
        "updated_task", 
        task.id, 
        activityDetails
      );
      
      res.json(task);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: error.errors[0].message });
      }
      console.error("Update task error:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  app.delete("/api/projects/:projectId/tasks/:taskId", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
      const task = await storage.getTask(req.params.taskId, req.params.projectId, req.userId!);
      
      const deleted = await storage.deleteTask(
        req.params.taskId,
        req.params.projectId,
        req.userId!
      );
      
      if (!deleted) {
        return res.status(404).json({ message: "Task not found or no permission" });
      }
      
      if (task) {
        await storage.createActivityLog(
          req.params.projectId, 
          req.userId!, 
          "deleted_task", 
          undefined, 
          `Deleted task "${task.title}"`
        );
      }
      
      res.json({ message: "Task deleted successfully" });
    } catch (error) {
      console.error("Delete task error:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  app.get("/api/projects/:projectId/tasks/:taskId/comments", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
      const task = await storage.getTask(req.params.taskId, req.params.projectId, req.userId!);
      if (!task) {
        return res.status(404).json({ message: "Task not found" });
      }
      
      const comments = await storage.getTaskComments(req.params.taskId);
      res.json(comments);
    } catch (error) {
      console.error("Get comments error:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  app.post("/api/projects/:projectId/tasks/:taskId/comments", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
      const access = await storage.getProjectWithAccess(req.params.projectId, req.userId!);
      if (!access || access.role === "viewer") {
        return res.status(403).json({ message: "No permission to comment" });
      }
      
      const validatedData = insertTaskCommentSchema.parse(req.body);
      
      const comment = await storage.createComment(
        req.params.taskId,
        req.userId!,
        validatedData.content
      );
      
      const user = await storage.getUser(req.userId!);
      
      await storage.createActivityLog(
        req.params.projectId, 
        req.userId!, 
        "added_comment", 
        req.params.taskId, 
        "Added a comment"
      );
      
      res.status(201).json({ ...comment, user: user ? { id: user.id, username: user.username, email: user.email } : null });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: error.errors[0].message });
      }
      console.error("Create comment error:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  app.put("/api/projects/:projectId/tasks/:taskId/comments/:commentId", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
      const validatedData = updateTaskCommentSchema.parse(req.body);
      
      const comment = await storage.updateComment(
        req.params.commentId,
        req.userId!,
        validatedData.content
      );
      
      if (!comment) {
        return res.status(404).json({ message: "Comment not found or no permission" });
      }
      
      res.json(comment);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: error.errors[0].message });
      }
      console.error("Update comment error:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  app.delete("/api/projects/:projectId/tasks/:taskId/comments/:commentId", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
      const deleted = await storage.deleteComment(req.params.commentId, req.userId!);
      
      if (!deleted) {
        return res.status(404).json({ message: "Comment not found or no permission" });
      }
      
      res.json({ message: "Comment deleted successfully" });
    } catch (error) {
      console.error("Delete comment error:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  app.post("/api/projects/:projectId/tasks/:taskId/attachments", authMiddleware, upload.single("file"), async (req: AuthRequest, res: Response) => {
    try {
      const access = await storage.getProjectWithAccess(req.params.projectId, req.userId!);
      if (!access || access.role === "viewer") {
        return res.status(403).json({ message: "No permission to upload files" });
      }
      
      const task = await storage.getTask(req.params.taskId, req.params.projectId, req.userId!);
      if (!task) {
        return res.status(404).json({ message: "Task not found" });
      }
      
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }
      
      const attachment = await storage.createAttachment(
        req.params.taskId,
        req.file.filename,
        req.file.originalname,
        req.file.mimetype,
        req.file.size,
        req.userId!
      );
      
      await storage.createActivityLog(
        req.params.projectId, 
        req.userId!, 
        "uploaded_file", 
        req.params.taskId, 
        `Uploaded "${req.file.originalname}"`
      );
      
      res.status(201).json(attachment);
    } catch (error) {
      console.error("Upload attachment error:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  app.get("/api/projects/:projectId/tasks/:taskId/attachments", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
      const task = await storage.getTask(req.params.taskId, req.params.projectId, req.userId!);
      if (!task) {
        return res.status(404).json({ message: "Task not found" });
      }
      
      const attachments = await storage.getTaskAttachments(req.params.taskId);
      res.json(attachments);
    } catch (error) {
      console.error("Get attachments error:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  app.get("/api/attachments/:attachmentId/download", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
      const attachment = await storage.getAttachment(req.params.attachmentId);
      if (!attachment) {
        return res.status(404).json({ message: "Attachment not found" });
      }
      
      const filePath = path.join(uploadDir, attachment.filename);
      
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ message: "File not found on server" });
      }
      
      res.download(filePath, attachment.originalName);
    } catch (error) {
      console.error("Download attachment error:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  app.delete("/api/projects/:projectId/tasks/:taskId/attachments/:attachmentId", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
      const attachment = await storage.getAttachment(req.params.attachmentId);
      
      const deleted = await storage.deleteAttachment(req.params.attachmentId, req.userId!);
      if (!deleted) {
        return res.status(404).json({ message: "Attachment not found or no permission" });
      }
      
      if (attachment) {
        const filePath = path.join(uploadDir, attachment.filename);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
        
        await storage.createActivityLog(
          req.params.projectId, 
          req.userId!, 
          "deleted_file", 
          req.params.taskId, 
          `Deleted "${attachment.originalName}"`
        );
      }
      
      res.json({ message: "Attachment deleted successfully" });
    } catch (error) {
      console.error("Delete attachment error:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  return httpServer;
}
