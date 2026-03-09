import React, { useState, useEffect } from 'react'
import { View, Text, StyleSheet, FlatList, ActivityIndicator, Alert, TouchableOpacity, Modal } from 'react-native'
import { supabase } from '../lib/supabase'
import { IconSymbol } from './ui/icon-symbol'

type JobStat = {
    id: string
    name: string
    activeWorkerCount: number
    totalHoursThisWeek: number
    hasLocation: boolean
}

export default function ManagerDashboard({ session }: { session: any }) {
    const [stats, setStats] = useState<JobStat[]>([])
    const [offsiteWorkers, setOffsiteWorkers] = useState<any[]>([])
    const [loading, setLoading] = useState(false)
    const [totalActiveWorkers, setTotalActiveWorkers] = useState(0)
    const [weeklyTotalHours, setWeeklyTotalHours] = useState(0)
    const [weeklyLaborCost, setWeeklyLaborCost] = useState(0)
    const [weeklyBurdenedCost, setWeeklyBurdenedCost] = useState(0)

    // List of Active Workers & Notifications
    const [activeWorkers, setActiveWorkers] = useState<any[]>([])
    const [notifications, setNotifications] = useState<any[]>([])
    const [editDetails, setEditDetails] = useState<Record<string, any>>({})
    const [viewDate, setViewDate] = useState(new Date())
    const [summaryWeekDate, setSummaryWeekDate] = useState(new Date())
    const [employees, setEmployees] = useState<any[]>([])
    const [employeeStats, setEmployeeStats] = useState<any[]>([])
    const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null)
    const [showEmployeeModal, setShowEmployeeModal] = useState(false)
    const [expandedSections, setExpandedSections] = useState({
        weekly: true,
        activeJobs: true,
        activity: true
    })

    useEffect(() => {
        fetchDashboardData()

        // Real-time subscription
        const subscription = supabase
            .channel('dashboard')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'time_entries' }, () => {
                fetchDashboardData(true)
            })
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications' }, () => {
                fetchDashboardData(true)
            })
            .subscribe()

        // Auto-refresh every 60 seconds for live counters
        const interval = setInterval(() => {
            fetchDashboardData(true)
        }, 60000)

        return () => {
            subscription.unsubscribe()
            clearInterval(interval)
        }
    }, [session, viewDate, summaryWeekDate, selectedEmployeeId])

    const fetchDashboardData = async (silent = false) => {
        if (!silent) setLoading(true)
        try {
            // 1. Fetch Active Jobs
            const { data: jobs, error: jobsError } = await supabase
                .from('jobs')
                .select('id, name, location_lat, location_lng')
                .eq('status', 'active')

            if (jobsError) throw jobsError

            // 1b. Fetch Profiles (Employees)
            const { data: profiles } = await supabase
                .from('profiles')
                .select('id, full_name')
                .in('role', ['worker', 'manager'])
                .order('full_name')

            if (profiles) setEmployees(profiles)

            // 2. Fetch All Active Time Entries (who is clocked in right now)
            const { data: activeEntries, error: activeError } = await supabase
                .from('time_entries')
                .select(`
                    id, 
                    start_time, 
                    job_id, 
                    offsite_ms,
                    is_offsite,
                    profiles ( full_name ),
                    jobs ( name ),
                    job_phases ( name, cost_code )
                `)
                .is('end_time', null)




                .order('start_time', { ascending: false })

            if (activeError) throw activeError

            setActiveWorkers(activeEntries || [])
            setTotalActiveWorkers(activeEntries?.length || 0)

            // 3. Fetch Activity Feed (Notifications) for the selected day
            const startOfViewDay = new Date(viewDate);
            startOfViewDay.setHours(0, 0, 0, 0);
            const endOfViewDay = new Date(viewDate);
            endOfViewDay.setHours(23, 59, 59, 999);

            let query = supabase
                .from('notifications')
                .select('*')
                .gte('created_at', startOfViewDay.toISOString())
                .lte('created_at', endOfViewDay.toISOString())
                .order('created_at', { ascending: false })

            if (selectedEmployeeId) {
                query = query.filter('data->>user_id', 'eq', selectedEmployeeId)
            }

            const { data: notes, error: notesError } = await query

            if (notes) {
                setNotifications(notes)
                // 3b. Fetch Edit Details in batch for any 'edit' notifications
                const editIds = notes
                    .filter(n => n.type === 'edit' && n.data?.entry_id)
                    .map(n => n.data.entry_id)

                if (editIds.length > 0) {
                    const { data: edDetails } = await supabase
                        .from('time_entries')
                        .select('id, start_time, end_time, original_start_time, original_end_time')
                        .in('id', editIds)

                    if (edDetails) {
                        const detailMap = edDetails.reduce((acc, curr) => ({ ...acc, [curr.id]: curr }), {})
                        setEditDetails(detailMap)
                    }
                }
            }

            // 4. Fetch All Time Entries for the selected summary week
            const weekStart = new Date(summaryWeekDate);
            weekStart.setDate(weekStart.getDate() - weekStart.getDay());
            weekStart.setHours(0, 0, 0, 0);

            const weekEnd = new Date(weekStart);
            weekEnd.setDate(weekEnd.getDate() + 6);
            weekEnd.setHours(23, 59, 59, 999);

            const { data: weeklyEntries, error: weeklyError } = await supabase
                .from('time_entries')
                .select('start_time, end_time, job_id, labor_cost, burdened_cost, user_id, profiles(full_name)')
                .gte('start_time', weekStart.toISOString())
                .lte('start_time', weekEnd.toISOString());

            if (weeklyError) throw weeklyError;

            // Calculate overall weekly totals and employee subtotals
            let totalHours = 0;
            let totalLabor = 0;
            let totalBurdened = 0;
            const empMap: Record<string, any> = {};

            weeklyEntries?.forEach(e => {
                let hours = 0;
                if (e.start_time && e.end_time) {
                    hours = (new Date(e.end_time).getTime() - new Date(e.start_time).getTime()) / (1000 * 60 * 60);
                    totalHours += hours;
                }
                const labor = Number(e.labor_cost || 0);
                const burdened = Number(e.burdened_cost || 0);
                totalLabor += labor;
                totalBurdened += burdened;

                if (!empMap[e.user_id]) {
                    const profileData = Array.isArray(e.profiles) ? e.profiles[0] : e.profiles
                    empMap[e.user_id] = {
                        name: profileData?.full_name || 'Unknown',
                        hours: 0,
                        cost: 0
                    }
                }
                empMap[e.user_id].hours += hours;
                empMap[e.user_id].cost += burdened;
            });

            setWeeklyTotalHours(totalHours);
            setWeeklyLaborCost(totalLabor);
            setWeeklyBurdenedCost(totalBurdened);
            setEmployeeStats(Object.values(empMap).sort((a, b) => b.hours - a.hours));

            // Aggregate counts for Job Cards
            const jobStats = jobs.map(job => {
                const jobWorkers = activeEntries?.filter(e => e.job_id === job.id) || []

                // Calculate weekly hours for this specific job
                const jobWeeklyHours = weeklyEntries
                    ?.filter(e => e.job_id === job.id && e.end_time)
                    .reduce((sum, e) => {
                        const hours = (new Date(e.end_time!).getTime() - new Date(e.start_time).getTime()) / (1000 * 60 * 60);
                        return sum + hours;
                    }, 0) || 0;

                return {
                    id: job.id,
                    name: job.name,
                    activeWorkerCount: jobWorkers.length,
                    totalHoursThisWeek: jobWeeklyHours,
                    workers: jobWorkers, // Pass workers to card
                    hasLocation: !!(job.location_lat && job.location_lng)
                }
            })

            // Sort: Jobs with workers first, then by hours
            jobStats.sort((a, b) => {
                if (b.activeWorkerCount !== a.activeWorkerCount) {
                    return b.activeWorkerCount - a.activeWorkerCount;
                }
                return b.totalHoursThisWeek - a.totalHoursThisWeek;
            })

            setStats(jobStats)
            setOffsiteWorkers(activeEntries?.filter(e => e.is_offsite) || [])

        } catch (error: any) {
            // console.error('Dash Error', error) // Silence mostly, table might be missing
        } finally {
            setLoading(false)
        }
    }

    const renderJobItem = ({ item }: { item: any }) => (
        <View style={styles.card}>
            <View style={styles.cardHeader}>
                <Text style={styles.jobName}>{item.name}</Text>
                {item.activeWorkerCount > 0 ? (
                    <View style={styles.badge}>
                        <Text style={styles.badgeText}>{item.activeWorkerCount} Active</Text>
                    </View>
                ) : (
                    <Text style={{ color: '#9ca3af', fontSize: 12 }}>{item.totalHoursThisWeek.toFixed(1)}h this week</Text>
                )}
            </View>

            {/* Geofencing Status Warning if missing location */}
            {item.activeWorkerCount > 0 && !item.hasLocation && (
                <View style={[styles.jobOffsiteAlert, { backgroundColor: '#fff7ed', borderColor: '#fdba74' }]}>
                    <IconSymbol name="exclamationmark.triangle.fill" size={12} color="#f97316" />
                    <Text style={[styles.jobOffsiteText, { color: '#ea580c' }]}>
                        Geofencing Disabled: Missing Job Address
                    </Text>
                </View>
            )}

            {item.workers?.some((w: any) => w.is_offsite) && (
                <View style={styles.jobOffsiteAlert}>
                    <IconSymbol name="exclamationmark.triangle.fill" size={12} color="#ef4444" />
                    <Text style={styles.jobOffsiteText}>
                        {item.workers.filter((w: any) => w.is_offsite).length} Off-site
                    </Text>
                </View>
            )}
            {item.activeWorkerCount > 0 && item.totalHoursThisWeek > 0 && (
                <Text style={styles.jobHoursSub}>{item.totalHoursThisWeek.toFixed(1)}h total this week</Text>
            )}

            {/* Embedded Active Workers List */}
            {item.workers && item.workers.length > 0 && (
                <View style={styles.workerList}>
                    {item.workers.map((w: any) => (
                        <View key={w.id} style={[styles.cardWorkerRow, w.is_offsite && { backgroundColor: '#fef2f2' }]}>
                            <View style={{ flex: 1 }}>
                                <Text style={[styles.cardWorkerName, w.is_offsite && { color: '#ef4444', fontWeight: 'bold' }]}>
                                    👤 {w.profiles?.full_name || 'Unknown'}
                                </Text>
                                {w.is_offsite ? (
                                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                        <IconSymbol name="exclamationmark.triangle.fill" size={10} color="#ef4444" />
                                        <Text style={{ color: '#ef4444', fontSize: 10, fontWeight: 'bold' }}>
                                            Currently Off-site since {new Date(w.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                        </Text>
                                    </View>
                                ) : w.offsite_ms > 0 ? (
                                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                        <IconSymbol name="exclamationmark.triangle.fill" size={10} color="#f59e0b" />
                                        <Text style={{ color: '#6b7280', fontSize: 10 }}>
                                            Off-site: {Math.round(w.offsite_ms / 60000)}m total
                                        </Text>
                                    </View>
                                ) : null}
                            </View>
                            <View style={{ alignItems: 'flex-end' }}>
                                <Text style={[styles.cardWorkerPhase, w.is_offsite && { color: '#b91c1c' }]}>
                                    {w.job_phases ? w.job_phases.name : 'General'}
                                </Text>
                                <Text style={styles.cardWorkerTime}>
                                    {new Date(w.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                </Text>
                            </View>
                        </View>
                    ))}






                </View>
            )}
        </View>
    )

    const getWeekRange = () => {
        const start = new Date(summaryWeekDate);
        start.setDate(start.getDate() - start.getDay());
        const end = new Date(start);
        end.setDate(end.getDate() + 6);
        return `${start.toLocaleDateString([], { month: 'short', day: 'numeric' })} - ${end.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
    };

    const navigateWeek = (direction: number) => {
        const newDate = new Date(summaryWeekDate);
        newDate.setDate(newDate.getDate() + (direction * 7));
        setSummaryWeekDate(newDate);
    };

    const toggleSection = (section: 'weekly' | 'activeJobs' | 'activity') => {
        setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
    };

    const renderHeader = () => {
        return (
            <View>
                <View style={styles.header}>
                    <View style={styles.headerTop}>
                        <Text style={styles.title}>Manager Dashboard</Text>
                        <TouchableOpacity
                            onPress={() => fetchDashboardData()}
                            style={styles.refreshIconBtn}
                            disabled={loading}
                        >
                            <IconSymbol name="arrow.clockwise" size={20} color="#2563eb" />
                        </TouchableOpacity>
                    </View>
                    <Text style={styles.subtitle}>{totalActiveWorkers} Active Workers</Text>
                </View>

                {/* Top Alert Banner for Off-site Workers */}
                {offsiteWorkers.length > 0 && (
                    <View style={styles.topAlertBanner}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                            <IconSymbol name="exclamationmark.triangle.fill" size={24} color="white" />
                            <View>
                                <Text style={styles.topAlertTitle}>
                                    {offsiteWorkers.length} {offsiteWorkers.length === 1 ? 'Worker' : 'Workers'} currently Off-site!
                                </Text>
                                <Text style={styles.topAlertSub}>
                                    Total off-site time today: {Math.round(offsiteWorkers.reduce((sum, w) => sum + (w.offsite_ms || 0), 0) / 60000)}m
                                </Text>
                            </View>
                        </View>
                    </View>
                )}

                {/* Weekly Summary Card */}
                <View style={styles.sectionContainer}>
                    <TouchableOpacity
                        style={styles.sectionHeaderRow}
                        onPress={() => toggleSection('weekly')}
                    >
                        <View style={{ flex: 1 }}>
                            <Text style={styles.sectionTitle}>Weekly Summary</Text>
                            <Text style={styles.sectionAffordance}>
                                Tap to {expandedSections.weekly ? 'hide' : 'view'} payroll details
                            </Text>
                        </View>
                        <IconSymbol
                            name={expandedSections.weekly ? "chevron.up" : "chevron.down"}
                            size={20}
                            color="#1e3a8a"
                        />
                    </TouchableOpacity>

                    {expandedSections.weekly && (
                        <View style={{ marginTop: 10 }}>
                            {/* Week Navigation */}
                            <View style={styles.dateNavContainer}>
                                <TouchableOpacity onPress={() => navigateWeek(-1)} style={styles.navCircLarge}>
                                    <IconSymbol name="chevron.left" size={24} color="#2563eb" />
                                </TouchableOpacity>
                                <View style={styles.dateInfo}>
                                    <Text style={styles.dateLabelLarge}>Payroll Week</Text>
                                    <Text style={styles.dateSubLabel}>{getWeekRange()}</Text>
                                </View>
                                <TouchableOpacity onPress={() => navigateWeek(1)} style={styles.navCircLarge}>
                                    <IconSymbol name="chevron.right" size={24} color="#2563eb" />
                                </TouchableOpacity>
                            </View>

                            <View style={styles.weeklyCard}>
                                <View style={styles.summaryGrid}>
                                    <View style={styles.summaryBox}>
                                        <Text style={styles.summaryLabel}>Total Hours</Text>
                                        <Text style={styles.summaryVal}>{weeklyTotalHours.toFixed(1)}h</Text>
                                    </View>
                                    <View style={styles.summaryBox}>
                                        <Text style={styles.summaryLabel}>Total Labor</Text>
                                        <Text style={styles.summaryVal}>${weeklyLaborCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</Text>
                                    </View>
                                    <View style={styles.summaryBox}>
                                        <Text style={styles.summaryLabel}>Burdened Cost</Text>
                                        <Text style={[styles.summaryVal, { color: '#2563eb' }]}>${weeklyBurdenedCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</Text>
                                    </View>
                                </View>

                                {employeeStats.length > 0 && (
                                    <View style={styles.employeeBreakdown}>
                                        <Text style={styles.breakdownTitle}>Employee Breakdown</Text>
                                        {employeeStats.map((emp, i) => (
                                            <View key={i} style={styles.employeeRow}>
                                                <Text style={styles.employeeName}>{emp.name}</Text>
                                                <View style={{ flexDirection: 'row', gap: 15 }}>
                                                    <Text style={styles.employeeHours}>{emp.hours.toFixed(1)}h</Text>
                                                    <Text style={styles.employeeCost}>${emp.cost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</Text>
                                                </View>
                                            </View>
                                        ))}
                                    </View>
                                )}
                            </View>
                        </View>
                    )}
                </View>

                {/* Off-site Monitoring Section */}
                {offsiteWorkers.length > 0 && (
                    <View style={[styles.sectionContainer, { borderLeftWidth: 4, borderLeftColor: '#ef4444' }]}>
                        <View style={styles.sectionHeaderRow}>
                            <View style={{ flex: 1 }}>
                                <Text style={[styles.sectionTitle, { color: '#ef4444' }]}>🔴 Off-site Alert ({offsiteWorkers.length})</Text>
                                <Text style={styles.sectionAffordance}>Workers currently away from job site</Text>
                            </View>
                            <IconSymbol name="exclamationmark.triangle.fill" size={20} color="#ef4444" />
                        </View>

                        <View style={{ marginTop: 10 }}>
                            {offsiteWorkers.map((w) => (
                                <View key={w.id} style={styles.offsiteAlertCard}>
                                    <View style={{ flex: 1 }}>
                                        <Text style={styles.offsiteWorkerName}>👤 {w.profiles?.full_name || 'Unknown'}</Text>
                                        <Text style={styles.offsiteJobDetails}>
                                            📍 {w.jobs?.name} • {w.job_phases?.name || 'General'}
                                        </Text>
                                    </View>
                                    <View style={{ alignItems: 'flex-end' }}>
                                        <Text style={styles.offsiteTimer}>
                                            {Math.round(w.offsite_ms / 60000)}m away
                                        </Text>
                                        <Text style={styles.offsiteSince}>
                                            Since {new Date(w.last_location_check || w.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                        </Text>
                                    </View>
                                </View>
                            ))}
                        </View>
                    </View>
                )}

                {/* Activity Feed Header */}
                <View style={styles.sectionContainer}>
                    <TouchableOpacity
                        style={styles.sectionHeaderRow}
                        onPress={() => toggleSection('activity')}
                    >
                        <View style={{ flex: 1 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                <Text style={styles.sectionTitle}>Activity Feed</Text>
                                <TouchableOpacity
                                    onPress={() => fetchDashboardData()}
                                    style={styles.refreshIconBtnSmall}
                                    disabled={loading}
                                >
                                    <IconSymbol name="arrow.clockwise" size={14} color="#1e3a8a" />
                                </TouchableOpacity>
                            </View>
                            <Text style={styles.sectionAffordance}>
                                Tap to {expandedSections.activity ? 'hide' : 'view'} daily logs
                            </Text>
                        </View>

                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                            <TouchableOpacity
                                style={styles.filterButton}
                                onPress={() => setShowEmployeeModal(true)}
                            >
                                <IconSymbol name="person.fill" size={14} color="#1e3a8a" />
                                <Text style={styles.filterButtonText} numberOfLines={1}>
                                    {employees.find(e => e.id === selectedEmployeeId)?.full_name || 'All'}
                                </Text>
                                <IconSymbol name="chevron.down" size={10} color="#94a3b8" />
                            </TouchableOpacity>
                            <IconSymbol
                                name={expandedSections.activity ? "chevron.up" : "chevron.down"}
                                size={20}
                                color="#1e3a8a"
                            />
                        </View>
                    </TouchableOpacity>

                    {expandedSections.activity && (
                        <View style={{ marginTop: 10 }}>
                            {/* Date Navigation Row (Full Width & Larger) */}
                            <View style={styles.dateNavContainer}>
                                <TouchableOpacity
                                    onPress={() => {
                                        const d = new Date(viewDate);
                                        d.setDate(d.getDate() - 1);
                                        setViewDate(d);
                                    }}
                                    style={styles.navCircLarge}
                                >
                                    <IconSymbol name="chevron.left" size={24} color="#4b5563" />
                                </TouchableOpacity>

                                <View style={styles.dateInfo}>
                                    <Text style={styles.dateLabelLarge}>
                                        {viewDate.toLocaleDateString(undefined, { weekday: 'long' })}
                                    </Text>
                                    <Text style={styles.dateSubLabel}>
                                        {viewDate.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}
                                    </Text>
                                </View>

                                <TouchableOpacity
                                    onPress={() => {
                                        const d = new Date(viewDate);
                                        d.setDate(d.getDate() + 1);
                                        setViewDate(d);
                                    }}
                                    style={styles.navCircLarge}
                                >
                                    <IconSymbol name="chevron.right" size={24} color="#4b5563" />
                                </TouchableOpacity>
                            </View>

                            <View style={styles.feedContainer}>
                                {notifications.length === 0 ? (
                                    <Text style={styles.emptyFeed}>No activity for this day</Text>
                                ) : (
                                    notifications.map(note => (
                                        <View key={note.id} style={[
                                            styles.feedItem,
                                            (note.type === 'alert' || note.data?.meal_skipped_reason) && styles.feedItemAlert
                                        ]}>
                                            <View style={[styles.feedDot,
                                            note.data?.meal_skipped_reason ? { backgroundColor: '#ef4444' } :
                                                note.type === 'clock_in' ? { backgroundColor: '#10b981' } :
                                                    note.type === 'clock_out' ? { backgroundColor: '#6b7280' } :
                                                        note.type === 'edit' ? { backgroundColor: '#f59e0b' } :
                                                            note.type === 'alert' ? { backgroundColor: '#ef4444' } : { backgroundColor: '#3b82f6' }
                                            ]} />
                                            <View style={{ flex: 1 }}>
                                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                                                    {note.type === 'alert' && <IconSymbol name="exclamationmark.triangle.fill" size={14} color="#ef4444" />}
                                                    <Text style={[
                                                        styles.feedMessage,
                                                        (note.type === 'alert' || note.data?.meal_skipped_reason) && { color: '#ef4444', fontWeight: 'bold' }
                                                    ]}>
                                                        {note.message}
                                                    </Text>
                                                </View>
                                                {note.type === 'edit' && (() => {
                                                    const formatTime = (iso: string | null) => iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '...';
                                                    const hasSnapshot = note.data?.old_start || note.data?.new_start;
                                                    if (hasSnapshot) {
                                                        return (
                                                            <View style={styles.editDiffBox}>
                                                                <Text style={styles.editDiffLabel}>Change Details:</Text>
                                                                <Text style={styles.editDiffText}>
                                                                    Start: {formatTime(note.data.old_start)} → {formatTime(note.data.new_start)}
                                                                </Text>
                                                                {(note.data.old_end || note.data.new_end) && (
                                                                    <Text style={styles.editDiffText}>
                                                                        End: {formatTime(note.data.old_end)} → {formatTime(note.data.new_end)}
                                                                    </Text>
                                                                )}
                                                            </View>
                                                        );
                                                    }
                                                    // 2. Fallback to Latest Data from time_entries (original vs latest)
                                                    // This is for older notifications created before the trigger fix.
                                                    const detail = editDetails[note.data?.entry_id];
                                                    if (detail && detail.original_start_time) {
                                                        return (
                                                            <View style={styles.editDiffBox}>
                                                                <Text style={styles.editDiffLabel}>Overall Change Details:</Text>
                                                                <Text style={styles.editDiffText}>
                                                                    Start: {formatTime(detail.original_start_time)} → {formatTime(detail.start_time)}
                                                                </Text>
                                                                {(detail.original_end_time || detail.end_time) && (
                                                                    <Text style={styles.editDiffText}>
                                                                        End: {formatTime(detail.original_end_time)} → {formatTime(detail.end_time)}
                                                                    </Text>
                                                                )}
                                                            </View>
                                                        );
                                                    }
                                                    return null;
                                                })()}
                                                <Text style={styles.feedTime}>
                                                    {new Date(note.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                                </Text>
                                            </View>
                                        </View>
                                    ))
                                )}
                            </View>
                        </View>
                    )}
                </View>

                {/* Active Jobs Header (Now follows activity) */}
                <View style={[styles.sectionContainer, { marginBottom: 10 }]}>
                    <TouchableOpacity
                        style={styles.sectionHeaderRow}
                        onPress={() => toggleSection('activeJobs')}
                    >
                        <View style={{ flex: 1 }}>
                            <Text style={styles.sectionTitle}>Active Jobs</Text>
                            <Text style={styles.sectionAffordance}>
                                Tap to {expandedSections.activeJobs ? 'hide' : 'view'} current work
                            </Text>
                        </View>
                        <IconSymbol
                            name={expandedSections.activeJobs ? "chevron.up" : "chevron.down"}
                            size={20}
                            color="#1e3a8a"
                        />
                    </TouchableOpacity>
                </View>

                <Modal
                    animationType="slide"
                    transparent={true}
                    visible={showEmployeeModal}
                    onRequestClose={() => setShowEmployeeModal(false)}
                >
                    <View style={styles.modalOverlay}>
                        <View style={styles.modalContent}>
                            <View style={styles.modalHeader}>
                                <Text style={styles.modalTitle}>Filter by Employee</Text>
                                <TouchableOpacity onPress={() => setShowEmployeeModal(false)}>
                                    <Text style={styles.closeButton}>Close</Text>
                                </TouchableOpacity>
                            </View>

                            <FlatList
                                data={[{ id: null, full_name: 'All Employees' }, ...employees]}
                                keyExtractor={(item) => item.id || 'all'}
                                style={{ maxHeight: 400 }}
                                renderItem={({ item }) => (
                                    <TouchableOpacity
                                        style={styles.modalItem}
                                        onPress={() => {
                                            setSelectedEmployeeId(item.id)
                                            setShowEmployeeModal(false)
                                        }}
                                    >
                                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                                            <Text style={[
                                                styles.modalItemText,
                                                selectedEmployeeId === item.id && { color: '#2563eb', fontWeight: 'bold' }
                                            ]}>
                                                {item.full_name}
                                            </Text>
                                            {selectedEmployeeId === item.id && (
                                                <IconSymbol name="checkmark" size={16} color="#2563eb" />
                                            )}
                                        </View>
                                    </TouchableOpacity>
                                )}
                            />
                        </View>
                    </View>
                </Modal>
            </View>
        )
    }

    return (
        <View style={styles.container}>
            <FlatList
                data={expandedSections.activeJobs ? stats : []}
                renderItem={renderJobItem}
                keyExtractor={item => item.id}
                refreshing={loading}
                onRefresh={fetchDashboardData}
                ListHeaderComponent={renderHeader}
                contentContainerStyle={{ paddingBottom: 20 }}
                ListEmptyComponent={expandedSections.activeJobs ? (
                    <Text style={styles.emptyText}>No active jobs found.</Text>
                ) : null}
            />
        </View>
    )
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        paddingTop: 10
    },
    header: {
        marginBottom: 10,
        backgroundColor: 'white',
        padding: 20,
        borderRadius: 12,
        elevation: 2
    },
    headerTop: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center'
    },
    refreshIconBtn: {
        padding: 5,
        backgroundColor: '#eff6ff',
        borderRadius: 8
    },
    refreshIconBtnSmall: {
        padding: 4,
        backgroundColor: '#eff6ff',
        borderRadius: 6,
        borderWidth: 1,
        borderColor: '#dbeafe'
    },
    title: {
        fontSize: 22,
        fontWeight: 'bold',
        color: '#111827'
    },
    subtitle: {
        fontSize: 16,
        color: '#10b981',
        fontWeight: '600',
        marginTop: 5,
        marginBottom: 15
    },
    summaryGrid: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        borderTopWidth: 1,
        borderTopColor: '#f3f4f6',
        paddingTop: 15
    },
    summaryBox: {
        flex: 1,
        alignItems: 'center'
    },
    summaryLabel: {
        fontSize: 10,
        color: '#64748b',
        fontWeight: 'bold',
        textTransform: 'uppercase',
        marginBottom: 2
    },
    summaryVal: {
        fontSize: 14,
        fontWeight: '700',
        color: '#111827'
    },
    jobHoursSub: {
        fontSize: 11,
        color: '#64748b',
        fontStyle: 'italic',
        marginTop: -2,
        marginBottom: 5
    },
    sectionContainer: {
        marginBottom: 15,
        paddingHorizontal: 4
    },
    sectionTitle: {
        fontSize: 17,
        fontWeight: '800',
        color: '#1e3a8a'
    },
    sectionHeaderRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        backgroundColor: '#f1f5f9',
        padding: 12,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: '#e2e8f0'
    },
    sectionAffordance: {
        fontSize: 11,
        color: '#64748b',
        fontWeight: '500',
        marginTop: 1
    },
    card: {
        backgroundColor: 'white',
        padding: 15,
        borderBottomWidth: 1,
        borderBottomColor: '#f1f5f9'
    },
    cardHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 5
    },
    jobName: {
        fontSize: 16,
        fontWeight: 'bold',
        color: '#374151'
    },
    badge: {
        backgroundColor: '#d1fae5',
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 12
    },
    badgeText: {
        color: '#059669',
        fontWeight: 'bold',
        fontSize: 12
    },

    // Worker List Inside Card
    workerList: {
        marginTop: 10,
        paddingTop: 10,
        borderTopWidth: 1,
        borderTopColor: '#f1f5f9'
    },
    cardWorkerRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginBottom: 4
    },
    cardWorkerName: { fontSize: 13, fontWeight: '600', color: '#334155' },
    cardWorkerPhase: { fontSize: 12, color: '#64748b', flex: 1, textAlign: 'right', marginRight: 10 },
    cardWorkerTime: { fontSize: 12, color: '#2563eb', fontWeight: 'bold' },

    // Feed
    feedContainer: {
        backgroundColor: 'white',
        padding: 15,
        borderRadius: 12,
        elevation: 1,
        borderWidth: 1,
        borderColor: '#f1f5f9'
    },
    feedItem: {
        flexDirection: 'row',
        marginBottom: 15,
        alignItems: 'flex-start'
    },
    feedDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
        marginTop: 6,
        marginRight: 10
    },
    feedMessage: {
        fontSize: 14,
        color: '#1e293b',
        lineHeight: 20
    },
    feedTime: {
        fontSize: 11,
        color: '#94a3b8',
        marginTop: 2
    },
    editDiffBox: {
        backgroundColor: '#fffbeb',
        padding: 8,
        borderRadius: 6,
        marginTop: 5,
        borderLeftWidth: 3,
        borderLeftColor: '#f59e0b'
    },
    editDiffLabel: {
        fontSize: 11,
        fontWeight: 'bold',
        color: '#92400e',
        marginBottom: 2
    },
    editDiffText: {
        fontSize: 12,
        color: '#451a03',
    },
    weeklyCard: {
        backgroundColor: 'white',
        borderRadius: 12,
        padding: 15,
        marginBottom: 20,
        elevation: 2,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 4,
        borderWidth: 1,
        borderColor: '#f1f5f9'
    },
    employeeBreakdown: {
        marginTop: 15,
        paddingTop: 15,
        borderTopWidth: 1,
        borderTopColor: '#f1f5f9'
    },
    breakdownTitle: {
        fontSize: 14,
        fontWeight: 'bold',
        color: '#64748b',
        marginBottom: 10,
        textTransform: 'uppercase',
        letterSpacing: 0.5
    },
    employeeRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: '#f8fafc'
    },
    employeeName: {
        fontSize: 15,
        fontWeight: '600',
        color: '#1e293b',
        flex: 1
    },
    employeeHours: {
        fontSize: 14,
        fontWeight: 'bold',
        color: '#64748b',
        width: 50,
        textAlign: 'right'
    },
    employeeCost: {
        fontSize: 14,
        fontWeight: 'bold',
        color: '#2563eb',
        width: 100,
        textAlign: 'right'
    },
    emptyFeed: {
        textAlign: 'center',
        color: '#94a3b8',
        fontStyle: 'italic',
        padding: 40,
        backgroundColor: '#f8fafc',
        borderRadius: 8,
        marginTop: 10
    },

    // Refined Activity Feed Layout
    dateNavContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: '#f8fafc',
        borderRadius: 12,
        padding: 15,
        marginBottom: 15,
        width: '100%',
        borderWidth: 1,
        borderColor: '#e2e8f0'
    },
    dateInfo: {
        alignItems: 'center',
        flex: 1
    },
    dateLabelLarge: {
        fontSize: 20,
        fontWeight: '900',
        color: '#0f172a',
        textTransform: 'capitalize'
    },
    dateSubLabel: {
        fontSize: 14,
        color: '#64748b',
        marginTop: 2,
        fontWeight: '500'
    },
    navCircLarge: {
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: 'white',
        alignItems: 'center',
        justifyContent: 'center',
        elevation: 2,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.1,
        shadowRadius: 2,
        borderWidth: 1,
        borderColor: '#e2e8f0'
    },

    emptyText: {
        textAlign: 'center',
        color: '#94a3b8',
        marginTop: 20
    },

    // Filter Styles
    filterButton: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#eff6ff',
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 20,
        gap: 6,
        borderWidth: 1,
        borderColor: '#dbeafe'
    },
    filterButtonText: {
        fontSize: 13,
        fontWeight: 'bold',
        color: '#1e40af',
        maxWidth: 80
    },

    // Modal Styles
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.5)',
        justifyContent: 'center',
        padding: 20
    },
    modalContent: {
        backgroundColor: 'white',
        borderRadius: 20,
        padding: 20,
        maxHeight: '80%',
        elevation: 5
    },
    modalHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 15,
        borderBottomWidth: 1,
        borderBottomColor: '#f1f5f9',
        paddingBottom: 15
    },
    modalTitle: {
        fontSize: 18,
        fontWeight: 'bold',
        color: '#0f172a'
    },
    closeButton: {
        color: '#2563eb',
        fontWeight: '800'
    },
    modalItem: {
        paddingVertical: 15,
        borderBottomWidth: 1,
        borderBottomColor: '#f8fafc'
    },
    modalItemText: {
        fontSize: 16,
        color: '#334155'
    },
    offsiteAlertCard: {
        backgroundColor: '#fef2f2',
        borderRadius: 12,
        padding: 12,
        marginBottom: 8,
        flexDirection: 'row',
        alignItems: 'center',
        borderWidth: 1,
        borderColor: '#fee2e2'
    },
    offsiteWorkerName: {
        fontSize: 15,
        fontWeight: 'bold',
        color: '#991b1b'
    },
    offsiteJobDetails: {
        fontSize: 12,
        color: '#b91c1c',
        marginTop: 2
    },
    offsiteTimer: {
        fontSize: 14,
        fontWeight: 'bold',
        color: '#ef4444'
    },
    offsiteSince: {
        fontSize: 10,
        color: '#b91c1c'
    },
    jobOffsiteAlert: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#fef2f2',
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 6,
        marginTop: 4,
        alignSelf: 'flex-start',
        gap: 4
    },
    jobOffsiteText: {
        fontSize: 11,
        color: '#ef4444',
        fontWeight: 'bold'
    },
    topAlertBanner: {
        backgroundColor: '#ef4444',
        padding: 15,
        borderRadius: 12,
        marginBottom: 15,
        marginHorizontal: 16,
        elevation: 4,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.2,
        shadowRadius: 4
    },
    topAlertTitle: {
        color: 'white',
        fontSize: 16,
        fontWeight: 'bold'
    },
    topAlertSub: {
        color: 'rgba(255,255,255,0.9)',
        fontSize: 12,
        marginTop: 2
    },
    feedItemAlert: {
        backgroundColor: '#fef2f2',
        borderLeftWidth: 4,
        borderLeftColor: '#ef4444'
    }
});
