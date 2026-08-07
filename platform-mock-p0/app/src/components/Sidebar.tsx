// screen 2: the sidebar nav frame.
//
// Which links a person sees is decided by their POSITION's capabilities, live —
// changing somebody's rung on the พนักงานและทีม screen has to take effect on
// their own nav immediately, not at their next login.
import type { ReactNode } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { USERS } from "../state/stores";
import { session } from "../state/session";
import { useApp } from "../state/AppContext";
import { ui } from "../state/ui";
import { paths } from "../navigation";
import { canEditTemplates, canSeeOffice, personCaption } from "../domain/people";
import { unreadCount } from "../domain/notifications";
import {
	BarChartIcon,
	BellIcon,
	BriefcaseIcon,
	CalendarDaysIcon,
	ClipboardListIcon,
	LayersIcon,
	LogOutIcon,
	MenuIcon,
	UsersIcon,
} from "./Icons";

function SidebarLink({
	to,
	title,
	icon,
	label,
	badge,
	end,
}: {
	to: string;
	title: string;
	icon: ReactNode;
	label: string;
	badge?: ReactNode;
	end?: boolean;
}) {
	return (
		<NavLink
			to={to}
			end={end}
			className={({ isActive }) => "sidebar-link" + (isActive ? " active" : "")}
			title={title}
		>
			<span className="sidebar-icon">{icon}</span>
			<span className="sidebar-label">{label}</span>
			{badge}
		</NavLink>
	);
}

export function Sidebar({ collapsed, mobileOpen, onToggle }: { collapsed: boolean; mobileOpen: boolean; onToggle: () => void }) {
	const { currentUserName, setCurrentUserName, bump } = useApp();
	const navigate = useNavigate();
	const name = currentUserName || "";
	const user = USERS[name];
	const unread = unreadCount(name);
	return (
		<aside className={"sidebar" + (collapsed ? " collapsed" : "") + (mobileOpen ? " mobile-open" : "")} id="sidebar">
			<div className="sidebar-head">
				<span className="sidebar-logo sidebar-label">KSK</span>
				<button className="sidebar-toggle" onClick={onToggle} title="ย่อ/ขยายเมนู">
					<MenuIcon />
				</button>
			</div>
			<nav className="sidebar-nav">
				<SidebarLink to={paths.myWork} end title="งานของฉัน" icon={<ClipboardListIcon />} label="งานของฉัน" />
				{canSeeOffice(name) ? (
					<SidebarLink to={paths.overview} title="ภาพรวมสำนักงาน" icon={<BarChartIcon />} label="ภาพรวมสำนักงาน" />
				) : null}
				<SidebarLink to={paths.customers} title="ลูกค้า" icon={<BriefcaseIcon />} label="ลูกค้า" />
				<SidebarLink to={paths.monthBoard} title="ปฏิทินงานประจำเดือน" icon={<CalendarDaysIcon />} label="ปฏิทินงานประจำเดือน" />
				{/* The notification surface lives in the nav frame the app
				    already has, as one more destination with a quiet count —
				    not a bell that opens a panel over the work. */}
				<SidebarLink
					to={paths.notifications}
					title="การแจ้งเตือน"
					icon={<BellIcon />}
					label="การแจ้งเตือน"
					badge={unread > 0 ? <span className="nav-badge">{unread > 99 ? "99+" : String(unread)}</span> : null}
				/>
				{canEditTemplates(name) ? (
					<SidebarLink to={paths.people} title="พนักงานและทีม" icon={<UsersIcon />} label="พนักงานและทีม" />
				) : null}
				{canEditTemplates(name) ? (
					<SidebarLink to={paths.jobTypes} title="ประเภทงาน" icon={<LayersIcon />} label="ประเภทงาน" />
				) : null}
			</nav>
			<div className="sidebar-user">
				<span className="avatar">{user ? user.initials : "สช"}</span>
				<span className="sidebar-user-info">
					<span className="sidebar-user-name">{name}</span>
					<span className="sidebar-user-role">{name ? personCaption(name) : ""}</span>
				</span>
			</div>
			<button
				className="btn sidebar-logout"
				title="ออกจากระบบ"
				onClick={() => {
					session.currentUserName = null;
					setCurrentUserName(null);
					// Somebody may have joined the office since this screen was last shown.
					ui.otherUsersShown = false;
					bump();
					navigate(paths.login);
				}}
			>
				<span className="sidebar-logout-label">ออกจากระบบ</span>
				<span className="sidebar-icon sidebar-logout-icon">
					<LogOutIcon />
				</span>
			</button>
		</aside>
	);
}
