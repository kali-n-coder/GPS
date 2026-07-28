import type { Timestamp } from "firebase/firestore";

export type Role = "student" | "teacher" | "admin";
export type Availability = "available" | "busy" | "away";

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
  latitude: number;
  longitude: number;
  accuracy: number;
  placeLabel: string;
  note: string;
  availability: Availability;
  sharing: boolean;
  updatedAt?: Timestamp;
}

