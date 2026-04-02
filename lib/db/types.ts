export type UserRole = 'OWNER' | 'MANAGER' | 'CONTRACTOR' | 'CLIENT';

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  createdAt: string;
}

export interface Business {
  id: string;
  ownerId: string;
  name: string;
  address?: string;
  phone?: string;
  settings: {
    currency: string;
    taxRate: number;
    markupDefault: number;
  };
}

export interface Project {
  id: string;
  businessId: string;
  clientId: string;
  name: string;
  status: 'LEAD' | 'ESTIMATE' | 'IN_PROGRESS' | 'COMPLETED' | 'ON_HOLD' | 'CANCELLED';
  budget?: number;
  startDate?: string;
  endDate?: string;
  createdAt: string;
}

export interface LineItem {
  id: string;
  projectId?: string;
  estimateId?: string;
  description: string;
  quantity: number;
  unit: string; // sqft, hours, each, etc.
  costPerUnit: number;
  markup: number;
  total: number;
  category: 'LABOR' | 'MATERIAL' | 'SUBCONTRACTOR' | 'OTHER';
}

export interface Lead {
  id: string;
  businessId: string;
  name: string;
  email?: string;
  phone?: string;
  source?: string;
  status: 'NEW' | 'CONTACTED' | 'QUALIFIED' | 'LOST' | 'CONVERTED';
  notes?: string;
  createdAt: string;
}
