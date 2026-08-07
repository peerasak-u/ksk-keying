import { useEffect } from "react";
import { Route, Routes } from "react-router-dom";
import { AppProvider, useApp } from "./state/AppContext";
import { registerAppBridge } from "./state/session";
import { AppShell } from "./components/AppShell";
import { ModalRoot } from "./components/Modal";
import { Toast } from "./components/Toast";
import { LoginPage } from "./pages/LoginPage";
import { MyWorkPage } from "./pages/MyWorkPage";
import { OverviewPage } from "./pages/OverviewPage";
import { CustomersPage } from "./pages/CustomersPage";
import { CustomerDetailPage } from "./pages/CustomerDetailPage";
import { MonthBoardPage } from "./pages/MonthBoardPage";
import { NotificationsPage } from "./pages/NotificationsPage";
import { PeoplePage } from "./pages/PeoplePage";
import { JobTypesPage } from "./pages/JobTypesPage";
import { ProjectDetailPage } from "./pages/ProjectDetailPage";
import { RunReviewPage } from "./pages/RunReviewPage";

export function App() {
	return (
		<AppProvider>
			<AppBody />
		</AppProvider>
	);
}

function AppBody() {
	const { showToast, bump } = useApp();
	// The two globals every domain function reaches for. Registered once, here,
	// so `showToast()` inside a pure domain module still reaches the screen.
	useEffect(() => registerAppBridge(showToast, bump), [showToast, bump]);

	return (
		<>
			<Routes>
				<Route path="/login" element={<LoginPage />} />
				<Route element={<AppShell />}>
					<Route path="/" element={<MyWorkPage />} />
					<Route path="/overview" element={<OverviewPage />} />
					<Route path="/customers" element={<CustomersPage />} />
					<Route path="/customers/:id" element={<CustomerDetailPage />} />
					<Route path="/month-board" element={<MonthBoardPage />} />
					<Route path="/notifications" element={<NotificationsPage />} />
					<Route path="/people" element={<PeoplePage />} />
					<Route path="/job-types" element={<JobTypesPage />} />
					<Route path="/projects/:id" element={<ProjectDetailPage />} />
					<Route path="/projects/:id/runs/:pi/:key/:no" element={<RunReviewPage />} />
				</Route>
			</Routes>
			{/* round 18: one dialog layer for the whole app, outside every page so
			    re-rendering the screen underneath a dialog can never wipe it. */}
			<ModalRoot />
			<Toast />
		</>
	);
}
