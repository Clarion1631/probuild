import AsyncStorage from '@react-native-async-storage/async-storage';

export const API_URL = 'http://10.0.2.2:3000/api';

async function fetchWithAuth(endpoint: string, options: RequestInit = {}) {
    const token = await AsyncStorage.getItem('next_api_token');

    const headers = {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer \${token}` } : {}),
        ...options.headers,
    };

    const response = await fetch(`\${API_URL}\${endpoint}`, {
        ...options,
        headers,
    });

    if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || `API Error: \${response.status}`);
    }

    return response.json();
}

export const api = {
    getProjects: () => fetchWithAuth('/projects'),
    getProjectBuckets: (projectId: string) => fetchWithAuth(`/projects/\${projectId}/buckets`),
    getTimeEntries: () => fetchWithAuth('/time-entries'),
    clockIn: (data: { projectId: string; budgetBucketId?: string; latitude?: number; longitude?: number }) =>
        fetchWithAuth('/time-entries', {
            method: 'POST',
            body: JSON.stringify(data),
        }),
    clockOut: (data: { id: string; latitude?: number; longitude?: number }) =>
        fetchWithAuth('/time-entries', {
            method: 'PUT',
            body: JSON.stringify({ ...data, endTime: new Date().toISOString() }),
        }),
};
