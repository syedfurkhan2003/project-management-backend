import { 
  users, projects, tasks, projectMembers, projectInvitations, taskComments, activityLogs, fileAttachments,
  type User, type InsertUser,
  type Project, type InsertProject, type UpdateProject,
  type Task, type InsertTask, type UpdateTask,
  type ProjectMember, type MemberRole,
  type ProjectInvitation, type InviteMember,
  type TaskComment, type InsertTaskComment, type UpdateTaskComment,
  type ActivityLog,
  type FileAttachment
} from "@shared/schema";
import { db } from "./db";
import { eq, and, desc, or, ilike, sql } from "drizzle-orm";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  
  getProjects(userId: string): Promise<Project[]>;
  getProject(id: string, userId: string): Promise<Project | undefined>;
  getProjectWithAccess(projectId: string, userId: string): Promise<{ project: Project; role: MemberRole } | undefined>;
  createProject(project: InsertProject & { userId: string }): Promise<Project>;
  updateProject(id: string, userId: string, updates: UpdateProject): Promise<Project | undefined>;
  deleteProject(id: string, userId: string): Promise<boolean>;
  
  getProjectMembers(projectId: string): Promise<(ProjectMember & { user: User })[]>;
  addProjectMember(projectId: string, userId: string, role: MemberRole): Promise<ProjectMember>;
  updateMemberRole(projectId: string, userId: string, role: MemberRole): Promise<ProjectMember | undefined>;
  removeMember(projectId: string, memberId: string): Promise<boolean>;
  
  getProjectInvitations(projectId: string): Promise<ProjectInvitation[]>;
  createInvitation(projectId: string, email: string, role: MemberRole, invitedBy: string): Promise<ProjectInvitation>;
  acceptInvitation(invitationId: string, userId: string): Promise<boolean>;
  declineInvitation(invitationId: string): Promise<boolean>;
  getPendingInvitationsForUser(email: string): Promise<(ProjectInvitation & { project: Project })[]>;
  
  getTasks(projectId: string, userId: string): Promise<Task[]>;
  getTask(id: string, projectId: string, userId: string): Promise<Task | undefined>;
  createTask(task: InsertTask & { projectId: string }, userId: string): Promise<Task | undefined>;
  updateTask(id: string, projectId: string, userId: string, updates: UpdateTask): Promise<Task | undefined>;
  deleteTask(id: string, projectId: string, userId: string): Promise<boolean>;
  
  getTaskComments(taskId: string): Promise<(TaskComment & { user: User })[]>;
  createComment(taskId: string, userId: string, content: string): Promise<TaskComment>;
  updateComment(commentId: string, userId: string, content: string): Promise<TaskComment | undefined>;
  deleteComment(commentId: string, userId: string): Promise<boolean>;
  
  createActivityLog(projectId: string, userId: string, action: string, taskId?: string, details?: string): Promise<ActivityLog>;
  getProjectActivityLogs(projectId: string, limit?: number): Promise<(ActivityLog & { user: User })[]>;
  
  createAttachment(taskId: string, filename: string, originalName: string, mimeType: string, size: number, uploadedBy: string): Promise<FileAttachment>;
  getTaskAttachments(taskId: string): Promise<FileAttachment[]>;
  deleteAttachment(attachmentId: string, userId: string): Promise<boolean>;
  getAttachment(attachmentId: string): Promise<FileAttachment | undefined>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user || undefined;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.email, email));
    return user || undefined;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db
      .insert(users)
      .values(insertUser)
      .returning();
    return user;
  }

  async getProjects(userId: string): Promise<Project[]> {
    const ownedProjects = await db
      .select()
      .from(projects)
      .where(eq(projects.userId, userId))
      .orderBy(desc(projects.createdAt));
    
    const memberProjects = await db
      .select({ project: projects })
      .from(projectMembers)
      .innerJoin(projects, eq(projectMembers.projectId, projects.id))
      .where(eq(projectMembers.userId, userId));
    
    const memberProjectsList = memberProjects.map(mp => mp.project);
    const allProjects = [...ownedProjects];
    
    for (const mp of memberProjectsList) {
      if (!allProjects.find(p => p.id === mp.id)) {
        allProjects.push(mp);
      }
    }
    
    return allProjects.sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  async getProject(id: string, userId: string): Promise<Project | undefined> {
    const access = await this.getProjectWithAccess(id, userId);
    return access?.project;
  }

  async getProjectWithAccess(projectId: string, userId: string): Promise<{ project: Project; role: MemberRole } | undefined> {
    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId));
    
    if (!project) return undefined;
    
    if (project.userId === userId) {
      return { project, role: "owner" };
    }
    
    const [membership] = await db
      .select()
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
    
    if (membership) {
      return { project, role: membership.role as MemberRole };
    }
    
    return undefined;
  }

  async createProject(project: InsertProject & { userId: string }): Promise<Project> {
    const [newProject] = await db
      .insert(projects)
      .values(project)
      .returning();
    return newProject;
  }

  async updateProject(id: string, userId: string, updates: UpdateProject): Promise<Project | undefined> {
    const access = await this.getProjectWithAccess(id, userId);
    if (!access || (access.role !== "owner" && access.role !== "admin")) {
      return undefined;
    }

    const [project] = await db
      .update(projects)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(projects.id, id))
      .returning();
    return project || undefined;
  }

  async deleteProject(id: string, userId: string): Promise<boolean> {
    const access = await this.getProjectWithAccess(id, userId);
    if (!access || access.role !== "owner") {
      return false;
    }

    const result = await db
      .delete(projects)
      .where(eq(projects.id, id))
      .returning();
    return result.length > 0;
  }

  async getProjectMembers(projectId: string): Promise<(ProjectMember & { user: User })[]> {
    const members = await db
      .select()
      .from(projectMembers)
      .where(eq(projectMembers.projectId, projectId))
      .innerJoin(users, eq(projectMembers.userId, users.id));
    
    return members.map(m => ({
      ...m.project_members,
      user: m.users
    }));
  }

  async addProjectMember(projectId: string, userId: string, role: MemberRole): Promise<ProjectMember> {
    const [member] = await db
      .insert(projectMembers)
      .values({ projectId, userId, role })
      .returning();
    return member;
  }

  async updateMemberRole(projectId: string, memberId: string, role: MemberRole): Promise<ProjectMember | undefined> {
    const [member] = await db
      .update(projectMembers)
      .set({ role })
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.id, memberId)))
      .returning();
    return member || undefined;
  }

  async removeMember(projectId: string, memberId: string): Promise<boolean> {
    const result = await db
      .delete(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.id, memberId)))
      .returning();
    return result.length > 0;
  }

  async getProjectInvitations(projectId: string): Promise<ProjectInvitation[]> {
    return db
      .select()
      .from(projectInvitations)
      .where(and(eq(projectInvitations.projectId, projectId), eq(projectInvitations.status, "pending")))
      .orderBy(desc(projectInvitations.createdAt));
  }

  async createInvitation(projectId: string, email: string, role: MemberRole, invitedBy: string): Promise<ProjectInvitation> {
    const [invitation] = await db
      .insert(projectInvitations)
      .values({ projectId, email, role, invitedBy })
      .returning();
    return invitation;
  }

  async acceptInvitation(invitationId: string, userId: string): Promise<boolean> {
    const [invitation] = await db
      .select()
      .from(projectInvitations)
      .where(eq(projectInvitations.id, invitationId));
    
    if (!invitation || invitation.status !== "pending") return false;

    await db
      .update(projectInvitations)
      .set({ status: "accepted" })
      .where(eq(projectInvitations.id, invitationId));

    await this.addProjectMember(invitation.projectId, userId, invitation.role as MemberRole);
    return true;
  }

  async declineInvitation(invitationId: string): Promise<boolean> {
    const result = await db
      .update(projectInvitations)
      .set({ status: "declined" })
      .where(eq(projectInvitations.id, invitationId))
      .returning();
    return result.length > 0;
  }

  async getPendingInvitationsForUser(email: string): Promise<(ProjectInvitation & { project: Project })[]> {
    const invitations = await db
      .select()
      .from(projectInvitations)
      .innerJoin(projects, eq(projectInvitations.projectId, projects.id))
      .where(and(eq(projectInvitations.email, email), eq(projectInvitations.status, "pending")));
    
    return invitations.map(i => ({
      ...i.project_invitations,
      project: i.projects
    }));
  }

  async getTasks(projectId: string, userId: string): Promise<Task[]> {
    const access = await this.getProjectWithAccess(projectId, userId);
    if (!access) return [];
    
    return db
      .select()
      .from(tasks)
      .where(eq(tasks.projectId, projectId))
      .orderBy(desc(tasks.createdAt));
  }

  async getTask(id: string, projectId: string, userId: string): Promise<Task | undefined> {
    const access = await this.getProjectWithAccess(projectId, userId);
    if (!access) return undefined;

    const [task] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.projectId, projectId)));
    return task || undefined;
  }

  async createTask(task: InsertTask & { projectId: string }, userId: string): Promise<Task | undefined> {
    const access = await this.getProjectWithAccess(task.projectId, userId);
    if (!access || access.role === "viewer") return undefined;

    const [newTask] = await db
      .insert(tasks)
      .values({
        ...task,
        dueDate: task.dueDate ? new Date(task.dueDate as unknown as string) : null,
      })
      .returning();
    return newTask;
  }

  async updateTask(id: string, projectId: string, userId: string, updates: UpdateTask): Promise<Task | undefined> {
    const access = await this.getProjectWithAccess(projectId, userId);
    if (!access || access.role === "viewer") return undefined;

    const updateData: Record<string, unknown> = { ...updates, updatedAt: new Date() };
    if (updates.dueDate !== undefined) {
      updateData.dueDate = updates.dueDate ? new Date(updates.dueDate) : null;
    }

    const [task] = await db
      .update(tasks)
      .set(updateData)
      .where(and(eq(tasks.id, id), eq(tasks.projectId, projectId)))
      .returning();
    return task || undefined;
  }

  async deleteTask(id: string, projectId: string, userId: string): Promise<boolean> {
    const access = await this.getProjectWithAccess(projectId, userId);
    if (!access || access.role === "viewer") return false;

    const result = await db
      .delete(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.projectId, projectId)))
      .returning();
    return result.length > 0;
  }

  async getTaskComments(taskId: string): Promise<(TaskComment & { user: User })[]> {
    const comments = await db
      .select()
      .from(taskComments)
      .innerJoin(users, eq(taskComments.userId, users.id))
      .where(eq(taskComments.taskId, taskId))
      .orderBy(desc(taskComments.createdAt));
    
    return comments.map(c => ({
      ...c.task_comments,
      user: c.users
    }));
  }

  async createComment(taskId: string, userId: string, content: string): Promise<TaskComment> {
    const [comment] = await db
      .insert(taskComments)
      .values({ taskId, userId, content })
      .returning();
    return comment;
  }

  async updateComment(commentId: string, userId: string, content: string): Promise<TaskComment | undefined> {
    const [comment] = await db
      .update(taskComments)
      .set({ content, updatedAt: new Date() })
      .where(and(eq(taskComments.id, commentId), eq(taskComments.userId, userId)))
      .returning();
    return comment || undefined;
  }

  async deleteComment(commentId: string, userId: string): Promise<boolean> {
    const result = await db
      .delete(taskComments)
      .where(and(eq(taskComments.id, commentId), eq(taskComments.userId, userId)))
      .returning();
    return result.length > 0;
  }

  async createActivityLog(projectId: string, userId: string, action: string, taskId?: string, details?: string): Promise<ActivityLog> {
    const [log] = await db
      .insert(activityLogs)
      .values({ projectId, userId, action, taskId: taskId || null, details: details || null })
      .returning();
    return log;
  }

  async getProjectActivityLogs(projectId: string, limit: number = 50): Promise<(ActivityLog & { user: User })[]> {
    const logs = await db
      .select()
      .from(activityLogs)
      .innerJoin(users, eq(activityLogs.userId, users.id))
      .where(eq(activityLogs.projectId, projectId))
      .orderBy(desc(activityLogs.createdAt))
      .limit(limit);
    
    return logs.map(l => ({
      ...l.activity_logs,
      user: l.users
    }));
  }

  async createAttachment(taskId: string, filename: string, originalName: string, mimeType: string, size: number, uploadedBy: string): Promise<FileAttachment> {
    const [attachment] = await db
      .insert(fileAttachments)
      .values({ taskId, filename, originalName, mimeType, size, uploadedBy })
      .returning();
    return attachment;
  }

  async getTaskAttachments(taskId: string): Promise<FileAttachment[]> {
    return db
      .select()
      .from(fileAttachments)
      .where(eq(fileAttachments.taskId, taskId))
      .orderBy(desc(fileAttachments.createdAt));
  }

  async deleteAttachment(attachmentId: string, userId: string): Promise<boolean> {
    const result = await db
      .delete(fileAttachments)
      .where(and(eq(fileAttachments.id, attachmentId), eq(fileAttachments.uploadedBy, userId)))
      .returning();
    return result.length > 0;
  }

  async getAttachment(attachmentId: string): Promise<FileAttachment | undefined> {
    const [attachment] = await db
      .select()
      .from(fileAttachments)
      .where(eq(fileAttachments.id, attachmentId));
    return attachment || undefined;
  }
}

export const storage = new DatabaseStorage();
