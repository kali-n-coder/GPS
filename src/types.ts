import type { Timestamp } from "firebase/firestore";

export type Role = "student" | "teacher" | "admin";
export type Availability = "available" | "busy" | "away";

export interface CampusPlace {
  id: string;
  label: string;
  left: number;
  top: number;
  active: boolean;
}

export interface AppUser {
  uid: string;
  displayName: string;
  email: string;
  photoURL?: string;
  role: Role;
  active: boolean;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface TeacherLocation {
  id: string;
  ownerId: string;
  displayName: string;
  photoURL?: string;
  role: "teacher" | "admin";
  placeId: string;
  note: string;
  availability: Availability;
  sharing: boolean;
  updatedAt?: Timestamp;
}
